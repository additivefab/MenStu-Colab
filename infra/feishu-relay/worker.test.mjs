import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "./worker.mjs";

test("forwards only the encrypted body and Feishu signature headers", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    captured = { url, init };
    return Response.json({ challenge: "verified" });
  });

  const body = JSON.stringify({ encrypt: "ciphertext" });
  const response = await handleRequest(
    new Request("https://relay.example/feishu/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "must-not-forward",
        "x-lark-request-nonce": "nonce",
        "x-lark-request-timestamp": "123",
        "x-lark-signature": "signed",
      },
      body,
    }),
    { UPSTREAM_URL: "https://upstream.example/events" },
  );

  assert.equal(response.status, 200);
  assert.equal(captured.url, "https://upstream.example/events");
  assert.equal(new TextDecoder().decode(captured.init.body), body);
  assert.equal(captured.init.headers.get("x-lark-signature"), "signed");
  assert.equal(captured.init.headers.get("cookie"), null);
  assert.deepEqual(await response.json(), { challenge: "verified" });
});

test("rejects non-JSON and oversized requests before forwarding", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called");
  });

  const nonJson = await handleRequest(
    new Request("https://relay.example/feishu/events", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    }),
  );
  assert.equal(nonJson.status, 415);

  const oversized = await handleRequest(
    new Request("https://relay.example/feishu/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(1024 * 1024 + 1),
      },
      body: "{}",
    }),
  );
  assert.equal(oversized.status, 413);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("provides a health check and returns JSON on upstream failure", async (t) => {
  const health = await handleRequest(new Request("https://relay.example/health"));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  const response = await handleRequest(
    new Request("https://relay.example/feishu/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream unavailable" });
});
