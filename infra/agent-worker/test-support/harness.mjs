// Test fixtures: a fake platform (local HTTP server speaking the
// /api/lab/agent-attempts contract), a local bare git repository, and
// profile/config builders. No network beyond 127.0.0.1.

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const WORKER_TOKEN = "wkr_test_token_0123456789abcdef";

export async function tempDir(t, prefix = "agent-worker-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * handlers: { claim?(), heartbeat?(body, count), events?(body), result?(body) }
 * Each may return {status, json}. Defaults: no work, lease renewed, 200.
 */
export async function startFakePlatform(t, handlers = {}) {
  const requests = [];
  const counters = { heartbeat: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const authorized = req.headers.authorization === `Bearer ${WORKER_TOKEN}` && req.url === "/api/lab/agent-attempts" && req.method === "POST";
    requests.push({ body, authorized });
    let reply = { status: 200, json: {} };
    if (!authorized) reply = { status: 401, json: { error: "unauthorized" } };
    else if (body.action === "claim") reply = (await handlers.claim?.(body)) ?? { status: 200, json: { work: null } };
    else if (body.action === "heartbeat") {
      counters.heartbeat += 1;
      reply = (await handlers.heartbeat?.(body, counters.heartbeat)) ?? { status: 200, json: { leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), cancelRequested: false } };
    } else if (body.action === "events") reply = (await handlers.events?.(body)) ?? { status: 200, json: { accepted: body.events.length } };
    else if (body.action === "result") reply = (await handlers.result?.(body)) ?? { status: 200, json: { ok: true } };
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.json));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    byAction: (action) => requests.filter((request) => request.body.action === action).map((request) => request.body),
    events: () => requests.filter((request) => request.body.action === "events").flatMap((request) => request.body.events),
  };
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

/** Bare repo at <root>/remote/<owner>/<name>.git with one commit. */
export async function createRepoFixture(root, { fullName = "lab/project", files } = {}) {
  const seed = path.join(root, "seed");
  await mkdir(seed, { recursive: true });
  const content = files ?? {
    "README.md": "# Project\n",
    "src/model.py": "def f(x):\n    return x\n",
    "src/old_helper.py": "def old():\n    pass\n",
    "scripts/run.sh": "#!/bin/sh\necho run\n",
    "assets/blob.bin": Buffer.from([0, 1, 2, 3, 255, 254, 0, 10]),
    "evaluation/protocol.md": "fixed protocol\n",
  };
  for (const [rel, data] of Object.entries(content)) {
    await mkdir(path.dirname(path.join(seed, rel)), { recursive: true });
    await writeFile(path.join(seed, rel), data);
  }
  git(seed, "init", "-q", "--initial-branch=main");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  const sha = git(seed, "rev-parse", "HEAD");
  const bare = path.join(root, "remote", `${fullName}.git`);
  await mkdir(path.dirname(bare), { recursive: true });
  git(root, "clone", "-q", "--bare", seed, bare);
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  return { sha, fullName, remoteBase: `file://${path.join(root, "remote")}`, bare };
}

export function makeTask(overrides = {}) {
  return {
    schema: "tanyan.task/v1",
    taskId: "task_0123456789abcdef",
    version: 1,
    studentId: "stu_1",
    title: "Add a scaling option",
    researchQuestion: "Does input scaling change convergence?",
    hypothesis: "Scaling by 2 speeds up convergence.",
    instructions: "Add a scale parameter to f in src/model.py.",
    acceptanceCriteria: "f(x, scale) returns x * scale; unit test added.",
    allowedPaths: ["src/**", "tests/**", "scripts/**", "assets/**"],
    protectedPaths: ["evaluation/**", ".github/**"],
    budget: { maxAgentMinutes: 5 },
    ...overrides,
  };
}

export function makeWork(repo, overrides = {}) {
  return {
    attemptId: "att_0123456789abcdef",
    leaseEpoch: 3,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    provider: "codex",
    modelId: "gpt-test",
    credentialProfileId: "cred_alice",
    baseCommitSha: repo.sha,
    task: makeTask(),
    contextSnapshotSha256: "0".repeat(64),
    repository: null,
    repositoryId: 42,
    repositoryFullName: repo.fullName,
    ...overrides,
  };
}

/** Provisions <profilesDir>/<id>/{codex/auth.json, claude/oauth_token} with 0600/0700. */
export async function provisionProfile(profilesDir, id, { claudeToken = "sk-ant-oat01-FAKE-TOKEN-0123456789abcdefghij" } = {}) {
  const dir = path.join(profilesDir, id);
  await mkdir(path.join(dir, "codex"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(dir, "claude"), { recursive: true, mode: 0o700 });
  await chmod(path.join(dir, "codex"), 0o700);
  await writeFile(path.join(dir, "codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt_fake_refresh_token_value" } }), { mode: 0o600 });
  await writeFile(path.join(dir, "claude", "oauth_token"), `${claudeToken}\n`, { mode: 0o600 });
  return dir;
}

export function makeConfig(root, platformUrl, overrides = {}) {
  return {
    platformUrl,
    workerId: "worker-test",
    workRoot: path.join(root, "work"),
    profilesDir: path.join(root, "profiles"),
    githubBaseUrl: "https://github.invalid",
    gitReadFallback: null,
    pollSeconds: 0.02,
    heartbeatSeconds: 0.05,
    eventFlushMs: 20,
    keepWorkspaces: false,
    limits: { defaultAgentMinutes: 5, maxAgentMinutes: 10, maxEventsPerAttempt: 500, cancelGraceSeconds: 0.3 },
    agent: { maxTurns: 12 },
    ...overrides,
  };
}

/** Recursively reads every file under dir as latin1 text (for leak checks). */
export async function readTreeText(dir) {
  const out = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push({ path: full, text: (await readFile(full)).toString("latin1") });
    }
  };
  await walk(dir);
  return out;
}

export function captureLogs() {
  const lines = [];
  return { lines, write: (line) => lines.push(line), text: () => lines.join("") };
}
