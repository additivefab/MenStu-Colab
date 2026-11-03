// Batch 7 (H8) independent regression tests for R01 and R04, written from the
// external assessment's finding descriptions only (docs/第二次评估_采纳与第7批_2026-11-03.md,
// section 三). They assert outcomes, not implementation details, so either fix
// strategy passes. Simulation only: fake platform, fake adapter, local git.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { FakeAdapter } from "./adapters/fake.mjs";
import { createPlatformClient } from "./platform-client.mjs";
import {
  captureLogs, createRepoFixture, makeConfig, makeWork, provisionProfile, readTreeText, startFakePlatform, tempDir, WORKER_TOKEN,
} from "./test-support/harness.mjs";
import { runWorker } from "./worker.mjs";
import { collectChanges, prepareWorkspace } from "./workspace.mjs";

// ---------------------------------------------------------------------------
// Tunables (override with env vars when a fix uses slower retry back-off).
// ---------------------------------------------------------------------------
const ms = (name, fallback) => Number(process.env[name] ?? fallback);
/** R04: how long the first worker loop may take to land the result. */
const R04_FIRST_RUN_MS = ms("B7_R04_FIRST_RUN_MS", 4000);
/** R04: how long a restarted worker (same workRoot) may take to land it. */
const R04_RESTART_MS = ms("B7_R04_RESTART_MS", 4000);
/** R04: quiet period after the result lands, to catch duplicate posts. */
const R04_SETTLE_MS = ms("B7_R04_SETTLE_MS", 300);
const POLL_MS = 20;

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await delay(POLL_MS);
  }
  return Boolean(await predicate());
}

// ---------------------------------------------------------------------------
// R01: collecting changes must never write through links planted in .git
// ---------------------------------------------------------------------------

async function workspaceFixture(t) {
  const root = await tempDir(t, "b7-r01-");
  const repo = await createRepoFixture(root);
  const config = makeConfig(root, "http://127.0.0.1:9", { gitReadFallback: { urlTemplate: `${repo.remoteBase}/{fullName}.git` } });
  const work = makeWork(repo);
  const workspace = await prepareWorkspace({ work, config, workRoot: config.workRoot, redactor: null });
  // A legitimate agent edit, so collection has something to do.
  await writeFile(path.join(workspace.repoDir, "src/model.py"), "def f(x, scale=1):\n    return x * scale\n");
  return { root, repo, workspace };
}

async function makeCanaryFile(root, name) {
  const canary = path.join(root, name);
  const content = `CANARY ${randomBytes(12).toString("hex")} must never change\n`;
  await writeFile(canary, content, { mode: 0o600 });
  return { canary, content };
}

/**
 * Outcome contract: collection either refuses with an error carrying a code
 * (e.g. WORKSPACE_TAMPERED), or succeeds; in both cases the canary is intact.
 */
async function collectAndCheck(workspace, baseSha, canaries) {
  let outcome;
  try {
    await collectChanges(workspace, baseSha);
    outcome = "collected";
  } catch (error) {
    assert.ok(typeof error?.code === "string" && error.code, `a refusal must carry an error code (got: ${error?.message})`);
    outcome = `refused:${error.code}`;
  }
  for (const { canary, content } of canaries) {
    const info = await lstat(canary).catch(() => null);
    assert.ok(info?.isFile(), `canary ${path.basename(canary)} must still exist as a regular file (outcome ${outcome})`);
    assert.equal(await readFile(canary, "utf8"), content, `canary ${path.basename(canary)} must be unchanged (outcome ${outcome})`);
  }
  return outcome;
}

test("R01 sanity: an untampered workspace still collects the agent's change", async (t) => {
  const { repo, workspace } = await workspaceFixture(t);
  const change = await collectChanges(workspace, repo.sha);
  assert.deepEqual(change.files.map((file) => file.path), ["src/model.py"]);
});

test("R01: .git/config symlinked to a canary outside the checkout is never written through", async (t) => {
  const { root, repo, workspace } = await workspaceFixture(t);
  const canary = await makeCanaryFile(root, "canary-config");
  const configPath = path.join(workspace.repoDir, ".git", "config");
  await rm(configPath);
  await symlink(canary.canary, configPath);
  await collectAndCheck(workspace, repo.sha, [canary]);
});

test("R01: .git/info replaced by a symlink to an outside directory: nothing in it is modified or removed", async (t) => {
  const { root, repo, workspace } = await workspaceFixture(t);
  const outsideDir = path.join(root, "canary-info");
  await mkdir(outsideDir);
  const attributes = await makeCanaryFile(outsideDir, "attributes");
  const exclude = await makeCanaryFile(outsideDir, "exclude");
  const infoPath = path.join(workspace.repoDir, ".git", "info");
  await rm(infoPath, { recursive: true, force: true });
  await symlink(outsideDir, infoPath);
  await collectAndCheck(workspace, repo.sha, [attributes, exclude]);
});

test("R01: .git/config hard-linked to a canary outside the checkout is never written through", async (t) => {
  const { root, repo, workspace } = await workspaceFixture(t);
  const canary = await makeCanaryFile(root, "canary-hardlink");
  const configPath = path.join(workspace.repoDir, ".git", "config");
  await rm(configPath);
  await link(canary.canary, configPath);
  await collectAndCheck(workspace, repo.sha, [canary]);
});

// ---------------------------------------------------------------------------
// R04: one transient failure posting the result must not lose it
// ---------------------------------------------------------------------------

test("R04: after one transient result failure the platform ends up with exactly one result, and the change is kept until confirmed", async (t) => {
  const root = await tempDir(t, "b7-r04-");
  const repo = await createRepoFixture(root);
  const attemptId = "att_b7r04_0123456789";
  const marker = `B7_R04_MARKER_${randomBytes(10).toString("hex")}`;
  const markerContent = `${marker}\n`;
  const markerBase64 = Buffer.from(markerContent).toString("base64");

  let config;
  let claimed = false;
  let resultCalls = 0;
  const accepted = [];
  const evidence = [];
  // Before a result is confirmed, the change set must still exist on disk:
  // either the workspace itself or a persisted copy of the result (outbox).
  const changeStillOnDisk = async () => {
    const files = await readTreeText(root);
    return files.some((file) => file.text.includes(marker) || file.text.includes(markerBase64));
  };

  const platform = await startFakePlatform(t, {
    claim: () => {
      if (claimed) return { status: 200, json: { work: null } };
      claimed = true;
      return { status: 200, json: { work: makeWork(repo, { attemptId }) } };
    },
    result: async (body) => {
      resultCalls += 1;
      evidence.push({ call: resultCalls, onDisk: await changeStillOnDisk(), workspaceExists: existsSync(path.join(config.workRoot, body.attemptId)) });
      if (resultCalls === 1) return { status: 503, json: { error: "temporarily unavailable" } };
      accepted.push({ ...body, confirmingCall: resultCalls });
      return { status: 200, json: { ok: true } };
    },
  });
  config = makeConfig(root, platform.url, { keepWorkspaces: false, gitReadFallback: { urlTemplate: `${repo.remoteBase}/{fullName}.git` } });
  await provisionProfile(config.profilesDir, "cred_alice");
  const logs = captureLogs();
  const fake = new FakeAdapter({
    script: async (ctx) => {
      await writeFile(path.join(ctx.workspaceDir, "src/model.py"), markerContent);
    },
  });
  const startWorker = () => {
    const controller = new AbortController();
    const client = createPlatformClient({ platformUrl: platform.url, workerToken: WORKER_TOKEN, timeoutMs: 2000 });
    const done = runWorker({ config, client, adapters: { codex: fake }, baseSecrets: [WORKER_TOKEN], logWrite: logs.write }, { signal: controller.signal });
    return { stop: async () => { controller.abort(); await done; } };
  };

  // Run 1: the worker loop may retry on its own.
  const first = startWorker();
  let landed = await waitUntil(() => accepted.length > 0, R04_FIRST_RUN_MS);
  await first.stop();
  // Run 2 (only if needed): a restart with the same workRoot may deliver it.
  if (!landed) {
    const second = startWorker();
    landed = await waitUntil(() => accepted.length > 0, R04_RESTART_MS);
    await delay(R04_SETTLE_MS);
    await second.stop();
  } else {
    await delay(R04_SETTLE_MS);
  }

  assert.ok(resultCalls >= 1, "the worker attempted to post a result");
  assert.ok(evidence[0].workspaceExists || evidence[0].onDisk, "change exists when the first (failing) post happens");
  assert.ok(landed, `the result was never confirmed by the platform (result calls: ${resultCalls}; worker log tail: ${logs.text().slice(-400)})`);
  const forAttempt = accepted.filter((body) => body.attemptId === attemptId);
  assert.equal(forAttempt.length, 1, "exactly one result accepted for the attempt");
  const [result] = forAttempt;
  assert.equal(result.outcome, "change_ready");
  const file = result.files.find((entry) => entry.path === "src/model.py");
  assert.ok(file, "the confirmed result carries the agent's change");
  assert.equal(Buffer.from(file.contentBase64, "base64").toString("utf8"), markerContent);
  // Interpretation (see report): "workspace not deleted before confirmation"
  // is asserted as "the change set is still on disk (workspace or a persisted
  // result copy) at the moment of the confirming post".
  const confirming = evidence.find((entry) => entry.call === result.confirmingCall);
  assert.ok(confirming.workspaceExists || confirming.onDisk, "the change set was deleted before the result was confirmed");
});
