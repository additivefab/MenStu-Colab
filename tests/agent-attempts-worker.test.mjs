import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { issueRunnerToken } from "../lib/lab-runner-auth.ts";
import { digest } from "../lib/local-password.ts";
import { LIMITS, canonicalJson, sha256Hex } from "../lib/research-loop/contracts.ts";
import { buildTaskSnapshot, parseTaskContent } from "../lib/research-loop/tasks-core.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Synthetic fixtures only. GitHub is not configured in this build (the W2
// stubs throw GithubNotConfiguredError), so `start` must answer 503 and claim
// must hand out `repository: null`. Queued attempts for the lab protocol are
// seeded directly in SQL with the same context hash the platform computes.
// Every outbound request is refused and counted.
test("agent attempts: start preconditions, lab lease protocol, path policy, cancel and revocation", { timeout: 240_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")]
      .map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "agent-attempts-fixture" },
    r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const studentActors = new Set(["a", "b"]);
  const cookie = (actor) => actor ? `tanyan_session=aa-${actor}; tanyan_persona=${studentActors.has(actor) ? "student" : "management"}` : "";
  const userPost = (path, body, actor = "a", extra = {}) => mf.dispatchFetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: cookie(actor), ...extra },
    body: JSON.stringify(body),
  });
  const userGet = (path, actor = "a") => mf.dispatchFetch(`${origin}${path}`, { headers: { cookie: cookie(actor) } });
  const tokens = {};
  const lab = (body, worker = "w1") => mf.dispatchFetch(`${origin}/api/lab/agent-attempts`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(worker ? { authorization: `Bearer ${tokens[worker]}` } : {}) },
    body: JSON.stringify(body),
  });
  const expectJson = async (response, expected = 200) => {
    assert.equal(response.status, expected, await response.clone().text());
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
    return response.json();
  };
  const baseSha = "a".repeat(40);
  const content = (overrides = {}) => ({
    title: "调整学习率", researchQuestion: "学习率调度是否影响收敛？", hypothesis: "余弦调度更稳定",
    instructions: "只修改 src 下的训练脚本", acceptanceCriteria: "单元测试通过",
    allowedPaths: ["src/**", ".github/**"], budget: { maxAgentMinutes: 20 }, ...overrides,
  });
  const fileOf = (path, text, action = "modify") => ({
    path, action, contentBase64: Buffer.from(text).toString("base64"),
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  const resultBody = (attemptId, leaseEpoch, files, overrides = {}) => ({
    action: "result", attemptId, leaseEpoch, outcome: "change_ready", modelId: "gpt-5-codex", sdkVersion: "0.0.0-test",
    files, unifiedDiff: "diff --git a/src/train.py b/src/train.py\n", tests: [{ command: "pytest", exitCode: 0, summary: "ok" }],
    usage: { inputTokens: 10 }, ...overrides,
  });

  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('aa-a', '代理测试甲', '博士', 2025, '实验', 1),
      ('aa-b', '代理测试乙', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (701, 'aa-a-user', '代理测试甲', 'student', 'aa-a'),
      (702, 'aa-b-user', '代理测试乙', 'student', 'aa-b'),
      (703, 'aa-mentor-user', '范围导师', 'mentor', NULL),
      (705, 'aa-super-user', '超级管理员', 'superadmin', NULL),
      (706, 'aa-outsider-user', '其他导师', 'mentor', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (703, 'aa-a', 1, 1)`).run();
    for (const [id, actor] of [[701, "a"], [702, "b"], [703, "mentor"], [705, "super"], [706, "outsider"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`aa-${actor}`), id).run();
    }
    await db.prepare(`INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (9001, 'tanyan-research-lab', 'Organization')`).run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch)
      VALUES ('aa-a', 5001, 9001, 'tanyan-research-lab/aa-a', 'main')`).run();
    for (const [id, kind] of [["rnr_w1", "agent"], ["rnr_w2", "agent"], ["rnr_compute", "compute"]]) {
      const issued = await issueRunnerToken();
      tokens[id.replace("rnr_", "")] = issued.token;
      await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES (?, ?, ?, ?)").bind(id, id, kind, issued.tokenSha256).run();
    }
    tokens.bogus = "x".repeat(43);

    // A confirmed task for student A, created through the API.
    const created = await expectJson(await userPost("/api/research-tasks", { action: "create", studentId: "aa-a", mutationId: "aa-task-main", ...content() }));
    const taskId = created.task.id;
    await expectJson(await userPost("/api/research-tasks", { action: "confirm", taskId, version: 1 }));
    const snapshotV1 = buildTaskSnapshot({ taskId, version: 1, studentId: "aa-a", content: parseTaskContent(content()) });

    let seq = 0;
    let firstAttempt;
    let secondAttempt;
    const seedAttempt = async ({ profileId = "cred_a_codex", requester = 701, version = 1, snapshot = snapshotV1, status = "queued", task = taskId, student = "aa-a" } = {}) => {
      seq += 1;
      const id = `att_${"0".repeat(28)}${String(seq).padStart(4, "0")}`;
      const context = await sha256Hex(canonicalJson({ task: snapshot, baseCommitSha: baseSha }));
      await db.prepare(`INSERT INTO agent_attempts (id, task_id, task_version, student_id, provider, credential_profile_id,
        github_repository_id, base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id, created_at)
        VALUES (?, ?, ?, ?, 'codex', ?, 5001, ?, ?, ?, ?, ?, datetime('now', ?))`)
        .bind(id, task, version, student, profileId, baseSha, context, status, `seed-${id}`, requester, `-${1000 - seq} seconds`).run();
      return id;
    };
    const claim = async (worker = "w1") => (await expectJson(await lab({ action: "claim" }, worker))).work;
    const attemptRow = (id) => db.prepare("SELECT * FROM agent_attempts WHERE id = ?").bind(id).first();

    await t.test("superadmin maps users to worker profiles without ever accepting secrets", async () => {
      await expectJson(await userGet("/api/admin/agent-credential-profiles", "a"), 403);
      await expectJson(await userPost("/api/admin/agent-credential-profiles", { action: "create", userId: 701, provider: "codex", workerId: "rnr_w1" }, "mentor"), 403);
      await expectJson(await userPost("/api/admin/agent-credential-profiles", { action: "create", userId: 701, provider: "codex", workerId: "rnr_w1", token: "sk-should-not-be-accepted" }, "super"), 400);
      await expectJson(await userPost("/api/admin/agent-credential-profiles", { action: "create", userId: 701, provider: "deepseek", workerId: "rnr_w1" }, "super"), 400);
      await expectJson(await userPost("/api/admin/agent-credential-profiles", { action: "create", userId: 701, provider: "codex", workerId: "rnr_compute" }, "super"), 404);
      await expectJson(await userPost("/api/admin/agent-credential-profiles", { action: "create", userId: 701, provider: "codex", workerId: "rnr_w1" }, "super", { origin: "https://evil.example" }), 403);
      const createdProfile = await expectJson(await userPost("/api/admin/agent-credential-profiles", { action: "create", userId: 701, provider: "codex", workerId: "rnr_w1" }, "super"));
      assert.equal(createdProfile.profiles.length, 1);
      assert.equal(createdProfile.profiles[0].workerId, "rnr_w1");
      assert.equal(createdProfile.workers.length, 2, "only agent workers are listed");
      await expectJson(await userPost("/api/admin/agent-credential-profiles", { action: "create", userId: 701, provider: "codex", workerId: "rnr_w2" }, "super"), 409);
      const columns = (await db.prepare("PRAGMA table_info(agent_credential_profiles)").all()).results.map((column) => column.name);
      assert.deepEqual(columns.filter((name) => /token|secret|key|password/i.test(name)), []);
      // Fixed ids for the protocol tests below.
      await db.prepare("UPDATE agent_credential_profiles SET id = 'cred_a_codex' WHERE user_id = 701 AND provider = 'codex'").run();
      await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES
        ('cred_m_codex', 703, 'codex', 'rnr_w1'), ('cred_b_codex', 702, 'codex', 'rnr_w1'), ('cred_s_codex', 705, 'codex', 'rnr_w2')`).run();
    });

    await t.test("start checks confirmation, repository link, credential profile and GitHub availability", async () => {
      const startBody = (overrides = {}) => ({ action: "start", taskId, provider: "codex", idempotencyKey: `start-${Math.random().toString(36).slice(2, 12)}`, ...overrides });
      await expectJson(await userPost("/api/agent-attempts", startBody(), "a", { origin: "https://evil.example" }), 403);
      await expectJson(await userPost("/api/agent-attempts", startBody(), "b"), 404);
      await expectJson(await userPost("/api/agent-attempts", startBody({ provider: "deepseek" })), 400);
      await expectJson(await userPost("/api/agent-attempts", startBody({ idempotencyKey: "x" })), 400);
      await expectJson(await userPost("/api/agent-attempts", startBody({ baseRef: "../main" })), 400);
      const missingProfile = await expectJson(await userPost("/api/agent-attempts", startBody({ provider: "claude" })), 409);
      assert.equal(missingProfile.code, "CREDENTIAL_PROFILE_MISSING");
      const draft = await expectJson(await userPost("/api/research-tasks", { action: "create", studentId: "aa-a", mutationId: "aa-task-draft", ...content() }));
      assert.equal((await expectJson(await userPost("/api/agent-attempts", startBody({ taskId: draft.task.id })), 409)).code, "TASK_NOT_CONFIRMED");
      const taskB = await expectJson(await userPost("/api/research-tasks", { action: "create", studentId: "aa-b", mutationId: "aa-task-b", ...content() }, "b"));
      await expectJson(await userPost("/api/research-tasks", { action: "confirm", taskId: taskB.task.id, version: 1 }, "b"));
      assert.equal((await expectJson(await userPost("/api/agent-attempts", startBody({ taskId: taskB.task.id }), "b"), 409)).code, "REPOSITORY_NOT_LINKED");
      const unavailable = await expectJson(await userPost("/api/agent-attempts", startBody()), 503);
      assert.equal(unavailable.code, "GITHUB_NOT_CONFIGURED");
      assert.equal((await db.prepare("SELECT count(*) AS n FROM agent_attempts").first()).n, 0);
    });

    await t.test("claim: worker isolation, FIFO, lease epoch, rebuilt snapshot and repository null without GitHub", async () => {
      await expectJson(await lab({ action: "claim" }, null), 401);
      await expectJson(await lab({ action: "claim" }, "bogus"), 401);
      await expectJson(await lab({ action: "claim" }, "compute"), 403);
      const first = await seedAttempt();
      const second = await seedAttempt();
      const other = await seedAttempt({ profileId: "cred_s_codex", requester: 705 });
      assert.equal(await claim("w2").then((work) => work.attemptId), other, "w2 only sees its own profiles");
      const work = await claim("w1");
      assert.equal(work.attemptId, first, "oldest queued attempt first");
      assert.equal(work.leaseEpoch, 1);
      assert.equal(work.provider, "codex");
      assert.equal(work.credentialProfileId, "cred_a_codex");
      assert.equal(work.baseCommitSha, baseSha);
      assert.deepEqual(work.task, snapshotV1);
      assert.equal(work.contextSnapshotSha256, await sha256Hex(canonicalJson({ task: snapshotV1, baseCommitSha: baseSha })));
      assert.equal(work.repository, null);
      assert.equal(work.repositoryId, 5001);
      assert.equal(work.repositoryFullName, "tanyan-research-lab/aa-a");
      assert.ok(Date.parse(work.leaseExpiresAt) > Date.now());
      assert.equal((await claim("w1")).attemptId, second);
      assert.equal(await claim("w1"), null);
      assert.equal((await attemptRow(first)).status, "running");
      assert.equal((await attemptRow(first)).worker_id, "rnr_w1");
      firstAttempt = first;
      secondAttempt = second;
    });

    await t.test("heartbeat and events are fenced by worker and lease epoch; events dedupe and enforce caps", async () => {
      const id = firstAttempt;
      assert.equal((await expectJson(await lab({ action: "heartbeat", attemptId: id, leaseEpoch: 2 }), 409)).code, "LEASE_LOST");
      assert.equal((await expectJson(await lab({ action: "heartbeat", attemptId: id, leaseEpoch: 1 }, "w2"), 409)).code, "LEASE_LOST");
      const beat = await expectJson(await lab({ action: "heartbeat", attemptId: id, leaseEpoch: 1 }));
      assert.equal(beat.cancelRequested, false);
      const event = (sequence, payload = { text: `step ${sequence}` }) => ({ sequence, kind: "message", payload });
      const firstBatch = await expectJson(await lab({ action: "events", attemptId: id, leaseEpoch: 1, events: [event(1), event(2), event(3)] }));
      assert.deepEqual([firstBatch.accepted, firstBatch.duplicates, firstBatch.lastSequence], [3, 0, 3]);
      const retry = await expectJson(await lab({ action: "events", attemptId: id, leaseEpoch: 1, events: [event(2), event(3), event(4)] }));
      assert.deepEqual([retry.accepted, retry.duplicates, retry.lastSequence], [1, 2, 4]);
      await expectJson(await lab({ action: "events", attemptId: id, leaseEpoch: 1, events: [event(6), event(5)] }), 400);
      await expectJson(await lab({ action: "events", attemptId: id, leaseEpoch: 1, events: [{ sequence: 7, kind: "secret_dump", payload: {} }] }), 400);
      const big = await expectJson(await lab({ action: "events", attemptId: id, leaseEpoch: 1, events: [event(8, { text: "x".repeat(LIMITS.maxAgentEventPayloadBytes) })] }), 413);
      assert.equal(big.code, "PAYLOAD_TOO_LARGE");
      const many = Array.from({ length: LIMITS.maxAgentEventsPerRequest + 1 }, (_, index) => event(100 + index));
      await expectJson(await lab({ action: "events", attemptId: id, leaseEpoch: 1, events: many }), 413);
      await expectJson(await lab({ action: "events", attemptId: id, leaseEpoch: 9, events: [event(9)] }), 409);
      await expectJson(await lab({ action: "events", attemptId: id, leaseEpoch: 1, events: [event(9)] }, "w2"), 409);
      const stored = (await db.prepare("SELECT sequence FROM agent_attempt_events WHERE attempt_id = ? ORDER BY sequence").bind(id).all()).results;
      assert.deepEqual(stored.map((row) => row.sequence), [1, 2, 3, 4]);
    });

    await t.test("T01: attempt detail and event log are visible only within the student's scope", async () => {
      const id = firstAttempt;
      const detail = await expectJson(await userGet(`/api/agent-attempts?attemptId=${id}&afterSequence=2`, "a"));
      assert.deepEqual(detail.events.map((event) => event.sequence), [3, 4]);
      assert.equal(detail.nextAfterSequence, 4);
      assert.equal(detail.attempt.status, "running");
      assert.equal(detail.attempt.credentialProfileId, undefined);
      await expectJson(await userGet(`/api/agent-attempts?attemptId=${id}&afterSequence=2`, "mentor"));
      for (const actor of ["b", "outsider"]) {
        const denied = await expectJson(await userGet(`/api/agent-attempts?attemptId=${id}`, actor), 404);
        assert.equal(denied.events, undefined);
        await expectJson(await userGet(`/api/agent-attempts?taskId=${taskId}`, actor), 404);
        await expectJson(await userPost("/api/agent-attempts", { action: "cancel", attemptId: id }, actor), 404);
      }
      await expectJson(await userGet(`/api/agent-attempts?attemptId=${id}&afterSequence=-1`, "a"), 400);
      assert.equal((await expectJson(await userGet(`/api/agent-attempts?taskId=${taskId}`, "a"))).attempts.length, 3);
    });

    await t.test("T04: a result outside allowed paths fails the attempt with POLICY_VIOLATION and no change request", async () => {
      const id = secondAttempt;
      const response = await expectJson(await lab(resultBody(id, 1, [fileOf("src/train.py", "lr = 0.1\n"), fileOf("docs/notes.md", "outside\n", "add")])));
      assert.equal(response.status, "failed");
      assert.equal(response.errorCode, "POLICY_VIOLATION");
      assert.deepEqual(response.policy.outsideAllowed, ["docs/notes.md"]);
      assert.equal(response.changeRequest, null);
      const row = await attemptRow(id);
      assert.equal(row.status, "failed");
      assert.equal(row.error_code, "POLICY_VIOLATION");
      assert.equal(row.diff_r2_key, null);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM change_requests WHERE attempt_id = ?").bind(id).first()).n, 0);
      assert.equal(await (await mf.getR2Bucket("FILES")).head(`agent-attempts/${id}/change.json`), null);
      // Traversal is a policy violation as well, never a stored change.
      const traversal = await seedAttempt();
      const work = await claim();
      assert.equal(work.attemptId, traversal);
      const bad = await expectJson(await lab(resultBody(traversal, work.leaseEpoch, [fileOf("src/../.github/x.yml", "x")])));
      assert.equal(bad.errorCode, "POLICY_VIOLATION");
    });

    await t.test("T05 + R2: protected paths need extra review; the change is stored with its sha256 and replays are idempotent", async () => {
      const id = firstAttempt;
      const bad = fileOf("src/train.py", "lr = 0.2\n");
      await expectJson(await lab(resultBody(id, 1, [{ ...bad, sha256: "0".repeat(64) }])), 400);
      await expectJson(await lab(resultBody(id, 1, [{ ...bad, contentBase64: "@@not-base64@@" }])), 400);
      await expectJson(await lab(resultBody(id, 1, [bad, bad])), 400);
      await expectJson(await lab(resultBody(id, 1, [])), 400);
      await expectJson(await lab(resultBody(id, 1, [bad], { unifiedDiff: "x".repeat(LIMITS.maxDiffBytes + 1) })), 413);
      await expectJson(await lab(resultBody(id, 2, [bad])), 409);
      await expectJson(await lab(resultBody(id, 1, [bad]), "w2"), 409);
      assert.equal((await attemptRow(id)).status, "running", "rejected results never change state");
      const files = [fileOf("src/train.py", "lr = 0.2\n"), fileOf(".github/workflows/ci.yml", "on: push\n", "add"), { path: "src/old.py", action: "delete" }];
      const response = await expectJson(await lab(resultBody(id, 1, files)));
      assert.equal(response.status, "change_ready");
      assert.deepEqual(response.policy, { outsideAllowed: [], protectedTouched: [".github/workflows/ci.yml"] });
      assert.equal(response.changeRequest.requiresExtraReview, true);
      assert.equal(response.changeRequest.status, "pending_review");
      assert.equal(response.changeRequest.branchName, `tanyan/${taskId.slice(-8)}/${id.slice(-8)}`);
      const row = await attemptRow(id);
      assert.equal(row.status, "change_ready");
      assert.equal(row.diff_r2_key, `agent-attempts/${id}/change.json`);
      assert.deepEqual(JSON.parse(row.changed_paths_json), [".github/workflows/ci.yml", "src/old.py", "src/train.py"]);
      assert.equal(row.model_id, "gpt-5-codex");
      const object = await (await mf.getR2Bucket("FILES")).get(`agent-attempts/${id}/change.json`);
      const text = await object.text();
      assert.equal(createHash("sha256").update(text).digest("hex"), row.diff_sha256);
      const change = JSON.parse(text);
      assert.deepEqual(Object.keys(change).sort(), ["files", "unifiedDiff"]);
      assert.deepEqual(change.files.map((file) => file.path), [".github/workflows/ci.yml", "src/old.py", "src/train.py"]);
      assert.equal(Buffer.from(change.files[2].contentBase64, "base64").toString(), "lr = 0.2\n");
      const cr = await db.prepare("SELECT * FROM change_requests WHERE attempt_id = ?").bind(id).first();
      assert.equal(cr.requires_extra_review, 1);
      assert.equal(cr.base_commit_sha, baseSha);
      assert.equal(cr.github_repository_id, 5001);
      assert.equal(cr.student_id, "aa-a");
      const replay = await expectJson(await lab(resultBody(id, 1, files)));
      assert.equal(replay.replayed, true);
      assert.equal(replay.changeRequest.id, cr.id);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM change_requests WHERE attempt_id = ?").bind(id).first()).n, 1);
      await expectJson(await lab({ action: "heartbeat", attemptId: id, leaseEpoch: 1 }), 409);
      const detail = await expectJson(await userGet(`/api/agent-attempts?attemptId=${id}`, "a"));
      assert.equal(detail.changeRequest.id, cr.id);
      // A change that only touches allowed, unprotected paths needs no extra review.
      const plain = await seedAttempt();
      const work = await claim();
      assert.equal(work.attemptId, plain);
      const ok = await expectJson(await lab(resultBody(plain, work.leaseEpoch, [fileOf("src/model.py", "x = 1\n")])));
      assert.equal(ok.changeRequest.requiresExtraReview, false);
    });

    await t.test("expired leases fail with LEASE_EXPIRED on heartbeat, GET or claim and are never re-dispatched", async () => {
      const viaHeartbeat = await seedAttempt();
      const work = await claim();
      assert.equal(work.attemptId, viaHeartbeat);
      await db.prepare("UPDATE agent_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(viaHeartbeat).run();
      assert.equal((await expectJson(await lab({ action: "heartbeat", attemptId: viaHeartbeat, leaseEpoch: work.leaseEpoch }), 409)).code, "LEASE_LOST");
      assert.equal((await attemptRow(viaHeartbeat)).error_code, "LEASE_EXPIRED");
      assert.equal((await attemptRow(viaHeartbeat)).status, "failed");

      const viaGet = await seedAttempt();
      assert.equal((await claim()).attemptId, viaGet);
      await db.prepare("UPDATE agent_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(viaGet).run();
      const detail = await expectJson(await userGet(`/api/agent-attempts?attemptId=${viaGet}`, "a"));
      assert.equal(detail.attempt.status, "failed");
      assert.equal(detail.attempt.errorCode, "LEASE_EXPIRED");

      const viaClaim = await seedAttempt();
      assert.equal((await claim()).attemptId, viaClaim);
      await db.prepare("UPDATE agent_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(viaClaim).run();
      assert.equal(await claim(), null, "an expired attempt is not handed out again");
      assert.equal((await attemptRow(viaClaim)).status, "failed");
      assert.equal((await attemptRow(viaClaim)).error_code, "LEASE_EXPIRED");
    });

    await t.test("cancel: queued attempts end immediately, running ones are cancel_requested until the worker reports", async () => {
      const queued = await seedAttempt();
      const canceled = await expectJson(await userPost("/api/agent-attempts", { action: "cancel", attemptId: queued }));
      assert.equal(canceled.attempt.status, "canceled");
      assert.equal((await attemptRow(queued)).cancel_requested_by_user_id, 701);
      assert.equal(await claim(), null);

      const running = await seedAttempt();
      const work = await claim();
      assert.equal(work.attemptId, running);
      const requested = await expectJson(await userPost("/api/agent-attempts", { action: "cancel", attemptId: running }, "mentor"));
      assert.equal(requested.attempt.status, "cancel_requested");
      assert.equal((await expectJson(await userPost("/api/agent-attempts", { action: "cancel", attemptId: running }))).replayed, true);
      assert.equal((await expectJson(await lab({ action: "heartbeat", attemptId: running, leaseEpoch: work.leaseEpoch }))).cancelRequested, true);
      const done = await expectJson(await lab(resultBody(running, work.leaseEpoch, [], { outcome: "canceled" })));
      assert.equal(done.status, "canceled");
      await expectJson(await userPost("/api/agent-attempts", { action: "cancel", attemptId: firstAttempt }), 409);
    });

    await t.test("T12: revoked profile, scope or repository stops new work and cancels in-flight work", async () => {
      // Profile deactivated while queued: claim cancels instead of dispatching.
      const queued = await seedAttempt({ profileId: "cred_m_codex", requester: 703 });
      await expectJson(await userPost("/api/admin/agent-credential-profiles", { action: "deactivate", id: "cred_m_codex" }, "super"));
      assert.equal(await claim(), null);
      assert.equal((await attemptRow(queued)).status, "canceled");
      assert.equal((await attemptRow(queued)).error_code, "CREDENTIAL_PROFILE_REVOKED");
      await db.prepare("UPDATE agent_credential_profiles SET active = 1 WHERE id = 'cred_m_codex'").run();

      // Mentor assignment revoked while running: next heartbeat requests cancel.
      const running = await seedAttempt({ profileId: "cred_m_codex", requester: 703 });
      const work = await claim();
      assert.equal(work.attemptId, running);
      await db.prepare("UPDATE mentor_student_assignments SET active = 0 WHERE mentor_user_id = 703").run();
      const beat = await expectJson(await lab({ action: "heartbeat", attemptId: running, leaseEpoch: work.leaseEpoch }));
      assert.equal(beat.cancelRequested, true);
      const row = await attemptRow(running);
      assert.equal(row.status, "cancel_requested");
      assert.equal(row.error_code, "ACCESS_REVOKED");
      const late = await expectJson(await lab(resultBody(running, work.leaseEpoch, [fileOf("src/train.py", "late\n")])));
      assert.equal(late.status, "canceled", "a revoked attempt never yields a change request");
      assert.equal((await db.prepare("SELECT count(*) AS n FROM change_requests WHERE attempt_id = ?").bind(running).first()).n, 0);
      await db.prepare("UPDATE mentor_student_assignments SET active = 1 WHERE mentor_user_id = 703").run();

      // Repository link revoked between heartbeat and result.
      const linked = await seedAttempt();
      const linkedWork = await claim();
      assert.equal(linkedWork.attemptId, linked);
      await db.prepare("UPDATE repository_links SET status = 'revoked' WHERE student_id = 'aa-a'").run();
      const result = await expectJson(await lab(resultBody(linked, linkedWork.leaseEpoch, [fileOf("src/train.py", "x\n")])));
      assert.equal(result.status, "failed");
      assert.equal(result.errorCode, "REPOSITORY_REVOKED");
      assert.equal(result.changeRequest, null);
      await db.prepare("UPDATE repository_links SET status = 'active' WHERE student_id = 'aa-a'").run();

      // Deactivated student account: queued work is not dispatched.
      const studentQueued = await seedAttempt();
      await db.prepare("UPDATE app_users SET active = 0 WHERE id = 701").run();
      assert.equal(await claim(), null);
      assert.equal((await attemptRow(studentQueued)).error_code, "ACCESS_REVOKED");
      await db.prepare("UPDATE app_users SET active = 1 WHERE id = 701").run();
    });

    await t.test("revise after confirm keeps the old snapshot for queued attempts and blocks new starts", async () => {
      const pinned = await seedAttempt();
      await expectJson(await userPost("/api/research-tasks", { action: "revise", taskId, expectedVersion: 1, ...content({ instructions: "新的执行说明", allowedPaths: ["lib/**"] }) }));
      const work = await claim();
      assert.equal(work.attemptId, pinned);
      assert.equal(work.task.version, 1);
      assert.equal(work.task.instructions, "只修改 src 下的训练脚本");
      assert.deepEqual(work.task, snapshotV1);
      // Policy is evaluated against the attempt's version (src/** allowed), not the new draft.
      const result = await expectJson(await lab(resultBody(pinned, work.leaseEpoch, [fileOf("src/train.py", "v1 policy\n")])));
      assert.equal(result.status, "change_ready");
      const blocked = await expectJson(await userPost("/api/agent-attempts", { action: "start", taskId, provider: "codex", idempotencyKey: "start-after-revise" }), 409);
      assert.equal(blocked.code, "TASK_NOT_CONFIRMED");
    });

    await t.test("canceling the task cancels queued attempts and requests cancel for running ones", async () => {
      await expectJson(await userPost("/api/research-tasks", { action: "confirm", taskId, version: 2 }));
      const snapshotV2 = buildTaskSnapshot({ taskId, version: 2, studentId: "aa-a", content: parseTaskContent(content({ instructions: "新的执行说明", allowedPaths: ["lib/**"] })) });
      const running = await seedAttempt({ version: 2, snapshot: snapshotV2 });
      const work = await claim();
      assert.equal(work.attemptId, running);
      assert.equal(work.task.version, 2);
      const queued = await seedAttempt({ version: 2, snapshot: snapshotV2 });
      await expectJson(await userPost("/api/research-tasks", { action: "cancel", taskId }));
      assert.equal((await attemptRow(queued)).status, "canceled");
      assert.equal((await attemptRow(queued)).error_code, "TASK_CANCELED");
      assert.equal((await attemptRow(running)).status, "cancel_requested");
      assert.equal((await expectJson(await lab({ action: "heartbeat", attemptId: running, leaseEpoch: work.leaseEpoch }))).cancelRequested, true);
      assert.equal(outbound, 0, "no request left the Worker");
    });
  } finally {
    await mf.dispose();
  }
});
