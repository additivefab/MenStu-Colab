import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

// All credentials below are fixtures. Outbound requests are intercepted locally.
const legacy = {
  FEISHU_APP_ID: "cli_0000000000000001",
  FEISHU_APP_SECRET: "test-only-original-oauth-secret",
  FEISHU_VERIFICATION_TOKEN: "test-only-original-webhook-token",
};
const dedicated = {
  FEISHU_BOT_APP_ID: "cli_0000000000000002",
  FEISHU_BOT_APP_SECRET: "test-only-independent-bot-secret",
};
const botToken = "test-only-independent-webhook-token";
const origin = "http://localhost";
const relayPath = "/api/feishu/long-connection";
const webhookPath = "/api/feishu/events";

async function withWorker(bindings, run) {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outboundRequests = 0;
  const worker = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")]
      .map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    d1Databases: { DB: "feishu-bot-config-test" },
    r2Buckets: ["FILES"],
    outboundService: () => {
      outboundRequests += 1;
      return new Response("External requests are disabled in this test", { status: 502 });
    },
  });
  try {
    await run(worker);
    assert.equal(outboundRequests, 0, "credential boundary checks must not contact Feishu");
  } finally {
    await worker.dispose();
  }
}

function ordinaryMessage(appId) {
  return {
    ...(appId === undefined ? {} : { app_id: appId }),
    event_id: "test-event-no-summary",
    event_type: "im.message.receive_v1",
    message: {
      message_id: "test-message-no-summary",
      chat_id: "test-group",
      chat_type: "group",
      message_type: "text",
      content: JSON.stringify({ text: "大家好，今天下午见。" }),
    },
  };
}

function sendJson(worker, path, body, extraHeaders = {}) {
  return worker.dispatchFetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function sendRelay(worker, body, secret) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = "test-bot-config-nonce-1234";
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}\n${nonce}\n${JSON.stringify(body)}`)
    .digest("hex");
  return sendJson(worker, relayPath, body, {
    "x-tanyan-timestamp": timestamp,
    "x-tanyan-nonce": nonce,
    "x-tanyan-signature": signature,
  });
}

async function expectStatus(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response;
}

async function expectLegacyOAuth(worker) {
  const response = await worker.dispatchFetch(origin + "/api/auth/feishu/config");
  await expectStatus(response, 200);
  const config = await response.json();
  assert.equal(config.configured, true);
  assert.equal(config.appId, legacy.FEISHU_APP_ID);
}

function challenge(token) {
  return { type: "url_verification", token, challenge: "local-test-challenge" };
}

test("Worker separates bot relay authentication from the original OAuth application", { timeout: 120_000 }, async () => {
  await withWorker({ ...legacy, ...dedicated }, async (worker) => {
    await expectLegacyOAuth(worker);

    const accepted = await sendRelay(worker, ordinaryMessage(dedicated.FEISHU_BOT_APP_ID), dedicated.FEISHU_BOT_APP_SECRET);
    await expectStatus(accepted, 200);
    assert.deepEqual(await accepted.json(), { code: 0, staged: false, filtered: true, outcome: "filtered" });

    await expectStatus(await sendRelay(worker, ordinaryMessage(dedicated.FEISHU_BOT_APP_ID), legacy.FEISHU_APP_SECRET), 403);
    await expectStatus(await sendRelay(worker, ordinaryMessage(legacy.FEISHU_APP_ID), dedicated.FEISHU_BOT_APP_SECRET), 403);
    await expectStatus(await sendRelay(worker, ordinaryMessage(), dedicated.FEISHU_BOT_APP_SECRET), 403);

    // A configured old webhook token must not enable the independent bot webhook.
    await expectStatus(await sendJson(worker, webhookPath, challenge(legacy.FEISHU_VERIFICATION_TOKEN)), 503);
  });
});

test("Worker webhook uses only the dedicated token and does not inherit the OAuth encrypt key", { timeout: 120_000 }, async () => {
  await withWorker({
    ...legacy,
    ...dedicated,
    FEISHU_ENCRYPT_KEY: "test-only-old-encrypt-key-must-not-be-used",
    FEISHU_BOT_VERIFICATION_TOKEN: botToken,
  }, async (worker) => {
    await expectLegacyOAuth(worker);
    await expectStatus(await sendJson(worker, webhookPath, challenge(legacy.FEISHU_VERIFICATION_TOKEN)), 403);
    const accepted = await sendJson(worker, webhookPath, challenge(botToken));
    await expectStatus(accepted, 200);
    assert.deepEqual(await accepted.json(), { challenge: "local-test-challenge" });
  });
});

test("Worker rejects every partial independent bot configuration without affecting OAuth", { timeout: 120_000 }, async (t) => {
  const cases = [
    ["only bot app ID", { FEISHU_BOT_APP_ID: dedicated.FEISHU_BOT_APP_ID }],
    ["only bot secret", { FEISHU_BOT_APP_SECRET: dedicated.FEISHU_BOT_APP_SECRET }],
    ["only bot verification token", { FEISHU_BOT_VERIFICATION_TOKEN: botToken }],
    ["only bot encrypt key", { FEISHU_BOT_ENCRYPT_KEY: "test-only-bot-encrypt-key" }],
  ];
  for (const [name, botBindings] of cases) {
    await t.test(name, async () => {
      await withWorker({ ...legacy, ...botBindings }, async (worker) => {
        await expectLegacyOAuth(worker);
        await expectStatus(await sendRelay(worker, ordinaryMessage(legacy.FEISHU_APP_ID), legacy.FEISHU_APP_SECRET), 503);
        await expectStatus(await sendJson(worker, webhookPath, challenge(legacy.FEISHU_VERIFICATION_TOKEN)), 503);
      });
    });
  }
});

test("Worker preserves legacy relay and webhook behavior without nonempty bot settings", { timeout: 120_000 }, async (t) => {
  const cases = [
    ["no bot settings", {}],
    ["empty and whitespace-only bot settings", {
      FEISHU_BOT_APP_ID: "  ",
      FEISHU_BOT_APP_SECRET: "",
      FEISHU_BOT_VERIFICATION_TOKEN: "\t",
      FEISHU_BOT_ENCRYPT_KEY: "\n ",
    }],
  ];
  for (const [name, botBindings] of cases) {
    await t.test(name, async () => {
      await withWorker({ ...legacy, ...botBindings }, async (worker) => {
        await expectLegacyOAuth(worker);
        // Older bridge messages may omit app_id and must remain accepted.
        await expectStatus(await sendRelay(worker, ordinaryMessage(), legacy.FEISHU_APP_SECRET), 200);
        await expectStatus(await sendRelay(worker, ordinaryMessage(legacy.FEISHU_APP_ID), legacy.FEISHU_APP_SECRET), 200);
        await expectStatus(await sendRelay(worker, ordinaryMessage(dedicated.FEISHU_BOT_APP_ID), legacy.FEISHU_APP_SECRET), 403);
        const accepted = await sendJson(worker, webhookPath, challenge(legacy.FEISHU_VERIFICATION_TOKEN));
        await expectStatus(accepted, 200);
        assert.deepEqual(await accepted.json(), { challenge: "local-test-challenge" });
      });
    });
  }
});
