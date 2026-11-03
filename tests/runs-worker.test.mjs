import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Run registry (spec §6.3) against the built Worker. Every fixture is
// synthetic; outbound network is blocked, GitHub is the unconfigured stub
// (claims return repository:null, raw-SHA creation returns 503). No real GPU,
// scheduler or GitHub is exercised here: the lab runner is simulated by
// direct protocol calls.
const EVAL = "e".repeat(64);
const DATA_MANIFEST = "a".repeat(64);
const SPLIT_MANIFEST = "b".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `registry.lab/train@${IMAGE_DIGEST}`;
const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("run registry: approval binding, lab lease protocol, egress and result review", { timeout: 240_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "runs-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const personas = { studentA: "student", studentB: "student" };
  const cookie = (actor) => actor ? `tanyan_session=runs-${actor}; tanyan_persona=${personas[actor] ?? "management"}` : "";
  const call = (path, { actor, method = "GET", body, headers = {} } = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { cookie: cookie(actor), ...(body ? { "content-type": "application/json", origin } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const expectJson = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    return JSON.parse(text);
  };
  const admin = (body, actor = "root", status = 200) => call("/api/admin/lab", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const runs = (body, actor = "studentA", status = 200) => call("/api/runs", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const results = (body, actor = "mentor1", status = 200) => call("/api/run-results", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const detail = (runId, actor = "studentA", status = 200) => call(`/api/runs?runId=${runId}`, { actor }).then((r) => expectJson(r, status));
  const lab = (token, body, status = 200) => mf.dispatchFetch(origin + "/api/lab/runs", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => expectJson(r, status));
  let keyCounter = 0;
  const key = (label = "k") => `${label}-${String(++keyCounter).padStart(6, "0")}`;

  try {
    const db = await applyD1Migrations(mf);
    const bucket = await mf.getR2Bucket("FILES");
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('rs-a', '运行测试甲', '博士', 2025, '实验', 1), ('rs-b', '运行测试乙', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (1101, 'rs-student-a', '运行测试甲', 'student', 'rs-a'), (1102, 'rs-student-b', '运行测试乙', 'student', 'rs-b'),
      (1103, 'rs-mentor-1', '审核导师一', 'mentor', NULL), (1104, 'rs-mentor-2', '审核导师二', 'mentor', NULL),
      (1105, 'rs-mentor-3', '只读导师', 'mentor', NULL), (1106, 'rs-root', '超级管理员', 'superadmin', NULL),
      (1107, 'rs-root-2', '超级管理员二', 'superadmin', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (1103, 'rs-a', 1, 1), (1104, 'rs-a', 1, 1), (1105, 'rs-a', 0, 1)`).run();
    const actors = [[1101, "studentA"], [1102, "studentB"], [1103, "mentor1"], [1104, "mentor2"], [1105, "mentor3"], [1106, "root"], [1107, "root2"]];
    for (const [id, actor] of actors) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`runs-${actor}`), id).run();
    }
    await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (77, 'synthetic-lab', 'Organization')").run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch) VALUES
      ('rs-a', 5001, 77, 'synthetic-lab/a-research', 'main'), ('rs-b', 5002, 77, 'synthetic-lab/b-research', 'main')`).run();
    for (const [taskId, studentId, userId] of [["task_rsa", "rs-a", 1101], ["task_rsb", "rs-b", 1102]]) {
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
        VALUES (?, ?, '合成任务', 'confirmed', 1, 1, ?, ?, ?)`).bind(taskId, studentId, userId, `seed-${taskId}`, `seed-${taskId}`).run();
      await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
        budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
        VALUES (?, 1, '合成任务', '合成问题', '合成说明', '合成标准', '{"maxGpuCount":2,"maxWalltimeMinutes":600}', ?, ?, ?, CURRENT_TIMESTAMP)`)
        .bind(taskId, "d".repeat(64), userId, userId).run();
    }
    // A published change request (normally produced by W3 + W2).
    await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_agentseed', '代理', 'agent', ?)").bind("f".repeat(64)).run();
    await db.prepare("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_seed', 1101, 'codex', 'rnr_agentseed')").run();
    await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
      base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
      VALUES ('att_seed', 'task_rsa', 1, 'rs-a', 'codex', 'cred_seed', 5001, ?, ?, 'change_ready', 'seed-attempt', 1101)`)
      .bind("0".repeat(40), "d".repeat(64)).run();
    await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, status)
      VALUES ('cr_seed', 'task_rsa', 'att_seed', 'rs-a', 5001, ?, 'tanyan/seed/seed', ?, 'open')`).bind("0".repeat(40), SHA_A).run();

    let runner, runnerToken, runner2Token, entrypoint, dataset, dataset2;
    await t.test("admin lab registry is superadmin-only, validates inputs and stores only the token hash", async () => {
      for (const actor of ["studentA", "mentor1"]) {
        await expectJson(await call("/api/admin/lab", { actor }), 403);
        await admin({ action: "register_runner", label: "x", kind: "compute" }, actor, 403);
      }
      const created = await admin({ action: "register_runner", label: "GPU 服务器", kind: "compute" });
      runner = created.runner.id;
      runnerToken = created.token;
      assert.match(runnerToken, /^[A-Za-z0-9_-]{32,128}$/);
      runner2Token = (await admin({ action: "register_runner", label: "空闲服务器", kind: "compute" })).token;
      const stored = await db.prepare("SELECT token_sha256 FROM lab_runners WHERE id = ?").bind(runner).first();
      assert.equal(stored.token_sha256, sha256(runnerToken));
      const registry = JSON.stringify(await expectJson(await call("/api/admin/lab", { actor: "root" })));
      assert.ok(!registry.includes(runnerToken) && !registry.includes(stored.token_sha256), "token never listed");

      const entry = { action: "register_entrypoint", studentId: "rs-a", name: "train", argv: ["python", "train.py"], imageRef: IMAGE,
        evaluationProtocolSha256: EVAL, paramsSchema: { lr: { type: "number", required: true, minimum: 0, maximum: 1 }, epochs: { type: "integer", default: 10, minimum: 1, maximum: 100 } } };
      await admin({ ...entry, argv: "python train.py --lr 0.1" }, "root", 400);
      await admin({ ...entry, argv: ["python train.py"] }, "root", 400);
      await admin({ ...entry, argv: ["sh;rm", "-rf"] }, "root", 400);
      await admin({ ...entry, imageRef: "registry.lab/train:latest" }, "root", 400);
      await admin({ ...entry, evaluationProtocolSha256: "nope" }, "root", 400);
      await admin({ ...entry, paramsSchema: { lr: { type: "shell" } } }, "root", 400);
      await admin({ ...entry, studentId: "missing-student" }, "root", 409);
      entrypoint = (await admin(entry)).entrypoint;
      assert.equal(entrypoint.githubRepositoryId, 5001, "repository resolved server-side from the student's link");

      const policy = { schema: "tanyan.egress/v1", allowedExtensions: [".json", ".txt", ".png", ".csv"], maxFileBytes: 1000, maxTotalBytes: 5000, allowImages: false, blockDatasetHashMatches: true };
      const ds = { action: "register_dataset", label: "合成数据 v1", runnerId: runner, manifestSha256: DATA_MANIFEST, splitManifestSha256: SPLIT_MANIFEST, egressPolicy: policy };
      await admin({ ...ds, egressPolicy: { ...policy, blockDatasetHashMatches: false } }, "root", 400);
      await admin({ ...ds, egressPolicy: { ...policy, allowedExtensions: ["JSON"] } }, "root", 400);
      await admin({ ...ds, runnerId: "rnr_agentseed" }, "root", 400);
      await admin({ ...ds, manifestSha256: "short" }, "root", 400);
      dataset = (await admin(ds)).dataset;
      dataset2 = (await admin({ ...ds, label: "未授权数据" })).dataset;
      await admin({ action: "grant_dataset", datasetVersionId: dataset.id, studentId: "rs-a" });
      const list = await expectJson(await call("/api/admin/lab", { actor: "root" }));
      assert.equal(list.runners.length, 3);
      assert.equal(list.grants.filter((grant) => grant.active).length, 1);
    });

    const createBody = (overrides = {}) => ({
      action: "create", taskId: "task_rsa", changeRequestId: "cr_seed", entrypointId: entrypoint.id, params: { lr: 0.1 },
      datasetVersionId: dataset.id, resources: { gpuCount: 1, walltimeMinutes: 60, memoryGb: 16 }, idempotencyKey: key("create"), ...overrides,
    });
    const approve = (run, actor = "mentor1", status = 200) => runs({ action: "approve", runId: run.runId, runSpecSha256: run.runSpecSha256 }, actor, status);
    const claim = (token = runnerToken) => lab(token, { action: "claim" });
    const queuedRun = async (overrides = {}) => {
      const run = await runs(createBody(overrides));
      await approve(run);
      return run;
    };
    const claimed = async (overrides = {}) => {
      const run = await queuedRun(overrides);
      const { work } = await claim();
      assert.equal(work?.runId, run.runId);
      return work;
    };
    const metricsContent = (protocol = EVAL) => JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: protocol, split: "test", values: { accuracy: 0.91 } });
    const file = (relativePath, content, { kind = "other", decision = "published", sizeBytes, sha } = {}) => ({
      artifact: { relativePath, sha256: sha ?? sha256(content), sizeBytes: sizeBytes ?? Buffer.byteLength(content), kind, egressDecision: decision, egressReason: "runner", labLocator: `lab://out/${relativePath}` },
      published: { relativePath, contentBase64: Buffer.from(content).toString("base64") },
    });
    const manifestFor = (work, items, { metricsArtifactPath = "metrics.json", overrides = {}, exitCode = 0 } = {}) => ({
      schema: "tanyan.manifest/v1", runId: work.runId, attempt: work.attempt, runSpecSha256: work.runSpecSha256, approvalId: work.approvalId,
      repository: { repositoryId: work.spec.repository.repositoryId, executedCommitSha: work.spec.executedCommitSha },
      inputs: { datasetVersionId: work.spec.dataset.versionId, manifestSha256: work.spec.dataset.manifestSha256,
        splitManifestSha256: work.spec.dataset.splitManifestSha256, evaluationProtocolSha256: work.spec.evaluationProtocolSha256, seeds: [7] },
      environment: { imageDigest: IMAGE_DIGEST, driverVersion: "550.00", gpuModel: "synthetic" },
      execution: { runnerId: runner, schedulerJobId: "4242", submitTag: work.submitTag, entrypointId: work.spec.entrypoint.id,
        startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T01:00:00Z", exitCode },
      metricsArtifactPath, artifacts: items.map((item) => item.artifact), ...overrides,
    });
    const complete = (work, items, options = {}, status = 200) => lab(runnerToken, {
      action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: options.outcome ?? "completed", exitCode: "exitCode" in options ? options.exitCode : 0,
      manifest: options.manifest === undefined ? manifestFor(work, items, options) : options.manifest,
      publishedFiles: (options.published ?? items).map((item) => item.published),
    }, status);
    const events = async (runId) => (await db.prepare("SELECT sequence, from_status, to_status, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence").bind(runId).all()).results;
    const status = async (runId) => (await db.prepare("SELECT status FROM runs WHERE id = ?").bind(runId).first()).status;
    const expireLease = (runId) => db.prepare("UPDATE runs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(runId).run();

    await t.test("create validates scope, budget (T16), params, grants and idempotency", async () => {
      await runs(createBody(), "studentB", 403);
      await runs(createBody({ resources: { gpuCount: 4, walltimeMinutes: 60, memoryGb: 16 } }), "studentA", 400);
      const overWalltime = await runs(createBody({ resources: { gpuCount: 1, walltimeMinutes: 601, memoryGb: 16 } }), "studentA", 400);
      assert.equal(overWalltime.code, "OVER_BUDGET");
      await runs(createBody({ params: { lr: 0.1, shell: "rm -rf /" } }), "studentA", 400);
      await runs(createBody({ params: { lr: 2 } }), "studentA", 400);
      await runs(createBody({ params: {} }), "studentA", 400);
      await runs(createBody({ datasetVersionId: dataset2.id }), "studentA", 403);
      await runs(createBody({ changeRequestId: undefined, executedCommitSha: SHA_A }), "studentA", 503);
      await runs(createBody({ changeRequestId: undefined }), "studentA", 400);
      await runs(createBody({ taskId: "task_rsb", changeRequestId: undefined, executedCommitSha: SHA_A }), "studentA", 403);
      const idempotencyKey = key("idem");
      const first = await runs(createBody({ idempotencyKey }));
      const replay = await runs(createBody({ idempotencyKey }));
      assert.equal(replay.runId, first.runId);
      assert.equal(replay.replayed, true);
      assert.equal(first.status, "awaiting_approval");
      const row = await db.prepare("SELECT submit_tag, attempt FROM runs WHERE id = ?").bind(first.runId).first();
      assert.equal(row.submit_tag, `tanyan-${first.runId}`);
      const spec = await db.prepare("SELECT canonical_json FROM run_specs WHERE sha256 = ?").bind(first.runSpecSha256).first();
      const parsed = JSON.parse(spec.canonical_json);
      assert.equal(sha256(spec.canonical_json), first.runSpecSha256, "hash covers the stored canonical JSON");
      assert.equal(parsed.executedCommitSha, SHA_A);
      assert.deepEqual(parsed.entrypoint.params, { lr: 0.1, epochs: 10 });
      assert.equal(parsed.evaluationProtocolSha256, EVAL);
      assert.equal(parsed.egress.allowImages, false);
      assert.equal(parsed.taskSnapshotSha256, "d".repeat(64));
      assert.equal(parsed.network, "deny");
      await runs({ action: "cancel", runId: first.runId });
    });

    await t.test("approval binds to the reviewed spec hash and rejects self-approval (T09/T10)", async () => {
      const x = await runs(createBody({ params: { lr: 0.1 } }));
      const y = await runs(createBody({ params: { lr: 0.2 } }));
      const z = await runs(createBody({ resources: { gpuCount: 2, walltimeMinutes: 60, memoryGb: 16 } }));
      assert.notEqual(x.runSpecSha256, y.runSpecSha256);
      assert.notEqual(x.runSpecSha256, z.runSpecSha256);
      const mismatch = await runs({ action: "approve", runId: y.runId, runSpecSha256: x.runSpecSha256 }, "mentor1", 409);
      assert.equal(mismatch.code, "SPEC_HASH_MISMATCH");
      await runs({ action: "approve", runId: y.runId }, "mentor1", 400);
      await approve(y, "studentA", 403);
      await approve(y, "studentB", 403);
      await approve(y, "mentor3", 403);
      // Branch moved from SHA A to SHA B after review: a new spec, new hash.
      await db.prepare("UPDATE change_requests SET head_commit_sha = ? WHERE id = 'cr_seed'").bind(SHA_B).run();
      const moved = await runs(createBody({ params: { lr: 0.1 } }));
      assert.notEqual(moved.runSpecSha256, x.runSpecSha256);
      await runs({ action: "approve", runId: moved.runId, runSpecSha256: x.runSpecSha256 }, "mentor1", 409);
      await db.prepare("UPDATE change_requests SET head_commit_sha = ? WHERE id = 'cr_seed'").bind(SHA_A).run();
      // No self-approval, including mentors and superadmins.
      const byMentor = await runs(createBody(), "mentor1");
      await approve(byMentor, "mentor1", 403);
      const byRoot = await runs(createBody({ params: { lr: 0.3 } }), "root");
      await approve(byRoot, "root", 403);
      const ok = await approve(byRoot, "root2");
      assert.equal(ok.status, "queued");
      await approve(byRoot, "mentor1", 409);
      const approvedX = await approve(x);
      const work = (await claim()).work;
      assert.equal(work.runId, byRoot.runId, "oldest queued first");
      await lab(runnerToken, { action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "failed", exitCode: 1, manifest: null });
      const workX = (await claim()).work;
      assert.equal(workX.runId, x.runId);
      assert.equal(workX.spec.executedCommitSha, SHA_A, "only the approved SHA is dispatched");
      assert.equal(workX.approvalId, approvedX.approvalId);
      assert.equal(workX.runSpecSha256, x.runSpecSha256);
      assert.equal(workX.repository, null, "GitHub App not configured: runner uses its own read access");
      await lab(runnerToken, { action: "complete", runId: workX.runId, leaseEpoch: workX.leaseEpoch, outcome: "failed", exitCode: 1, manifest: null });
      for (const run of [y, z, moved, byMentor]) await runs({ action: "cancel", runId: run.runId });
    });

    let completedWork, completedDetail;
    await t.test("claim, lease fencing and a verified completion (T18) with student-scoped artifacts (T01)", async () => {
      assert.deepEqual(await claim(), { work: null });
      const work = await claimed();
      assert.equal(work.mode, "execute");
      assert.equal(work.leaseEpoch, 1);
      assert.equal(work.submitTag, `tanyan-${work.runId}`);
      assert.deepEqual(await claim(), { work: null }, "a leased run is never handed out twice");
      assert.deepEqual(await claim(runner2Token), { work: null }, "other runners never see it");
      const beat = { action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running", schedulerJobId: "4242" };
      assert.equal((await lab(runnerToken, { ...beat, leaseEpoch: 99 }, 409)).code, "LEASE_LOST");
      assert.equal((await lab(runner2Token, beat, 409)).code, "LEASE_LOST");
      const unauth = await mf.dispatchFetch(origin + "/api/lab/runs", { method: "POST", headers: { authorization: "Bearer " + "x".repeat(40) }, body: "{}" });
      assert.equal(unauth.status, 401);
      await unauth.text();
      const hb = await lab(runnerToken, beat);
      assert.equal(hb.cancelRequested, false);
      assert.ok(Date.parse(hb.leaseExpiresAt) > Date.now());
      assert.equal((await lab(runnerToken, { ...beat, phase: "dispatching" }, 409)).code, "INVALID_PHASE");
      await lab(runnerToken, { ...beat, phase: "collecting" });
      const items = [file("metrics.json", metricsContent(), { kind: "metrics" }), file("tables/summary.csv", "a,b\n1,2\n", { kind: "table" })];
      const done = await complete(work, items);
      assert.equal(done.status, "completed");
      assert.equal(done.technicalValidity, "valid");
      assert.deepEqual((await complete(work, items)), { status: "completed", replayed: true });
      completedWork = work;
      completedDetail = await detail(work.runId);
      assert.equal(completedDetail.run.status, "completed");
      assert.equal(completedDetail.result.technicalValidity, "valid");
      assert.deepEqual(completedDetail.result.metrics.values, { accuracy: 0.91 });
      assert.equal(completedDetail.review.state, "pending");
      assert.equal(completedDetail.spec.executedCommitSha, SHA_A);
      assert.equal(completedDetail.approvals.find((item) => item.current)?.runId, work.runId);
      const sequences = completedDetail.events.map((event) => event.sequence);
      assert.deepEqual(sequences, sequences.map((_, index) => index + 1), "event sequence is gap-free and monotonic");
      assert.deepEqual(completedDetail.events.map((event) => event.toStatus),
        ["awaiting_approval", "queued", "dispatching", "running", "collecting", "completed"]);
      const metricsArtifact = completedDetail.artifacts.find((item) => item.relativePath === "metrics.json");
      assert.equal(metricsArtifact.downloadable, true);
      assert.equal(completedDetail.result.metricsSourceArtifactId, metricsArtifact.id);
      const object = await bucket.get(`runs/${work.runId}/tables/summary.csv`);
      assert.equal(await object.text(), "a,b\n1,2\n");
      // T01: artifact and run reads are student-scoped.
      for (const actor of ["studentA", "mentor3", "root"]) {
        const response = await call(`/api/run-artifacts?artifactId=${metricsArtifact.id}`, { actor });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.match(response.headers.get("content-disposition"), /^attachment/);
        assert.equal(await response.text(), metricsContent());
      }
      await expectJson(await call(`/api/run-artifacts?artifactId=${metricsArtifact.id}`, { actor: "studentB" }), 403);
      await expectJson(await call(`/api/run-artifacts?artifactId=${metricsArtifact.id}`, {}), 401);
      await detail(work.runId, "studentB", 403);
      await expectJson(await call("/api/runs?taskId=task_rsa", { actor: "studentB" }), 403);
      await expectJson(await call("/api/runs?studentId=rs-a", { actor: "studentB" }), 403);
      const listed = await expectJson(await call("/api/runs?studentId=rs-a", { actor: "studentA" }));
      assert.ok(listed.runs.some((run) => run.id === work.runId && run.technicalValidity === "valid"));
      assert.deepEqual(listed.options.entrypoints.map((item) => item.id), [entrypoint.id]);
      assert.deepEqual(listed.options.datasets.map((item) => item.id), [dataset.id]);
      // Review CAS; a completed run is never re-opened.
      await results({ action: "review", runId: work.runId, expectedVersion: 1, state: "accepted", hypothesisOutcome: "supported", note: "ok" }, "studentA", 403);
      await results({ action: "review", runId: work.runId, expectedVersion: 1, state: "accepted", hypothesisOutcome: "supported", note: "ok" }, "mentor3", 403);
      const reviewed = await results({ action: "review", runId: work.runId, expectedVersion: 1, state: "accepted", hypothesisOutcome: "supported", note: "复核通过" });
      assert.equal(reviewed.version, 2);
      await results({ action: "review", runId: work.runId, expectedVersion: 1, state: "rejected", note: "stale" }, "mentor2", 409);
      await runs({ action: "cancel", runId: work.runId }, "studentA", 409);
      assert.equal((await lab(runnerToken, beat, 409)).code, "LEASE_LOST");
      assert.equal(await status(work.runId), "completed");
    });

    await t.test("a lost claim/submit response is reconciled, never re-dispatched (T11)", async () => {
      const work = await claimed();
      await lab(runnerToken, { action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running", schedulerJobId: "777" });
      // The runner lost the next response and restarts: nothing new while the lease holds.
      assert.deepEqual(await claim(), { work: null });
      await expireLease(work.runId);
      const again = (await claim()).work;
      assert.equal(again.mode, "reconcile");
      assert.equal(again.runId, work.runId);
      assert.equal(again.leaseEpoch, work.leaseEpoch + 1);
      assert.equal(again.schedulerJobId, "777");
      assert.equal(again.repository, null);
      assert.equal(await status(work.runId), "reconciling");
      assert.equal((await lab(runnerToken, { action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running" }, 409)).code, "LEASE_LOST");
      assert.equal((await lab(runnerToken, { action: "heartbeat", runId: work.runId, leaseEpoch: again.leaseEpoch, phase: "running" }, 409)).code, "RECONCILE_REQUIRED");
      const reconciled = await lab(runnerToken, { action: "reconcile", runId: work.runId, leaseEpoch: again.leaseEpoch, found: true, schedulerJobId: "777", schedulerState: "running" });
      assert.equal(reconciled.status, "running");
      assert.equal(reconciled.cancelRequested, false);
      assert.deepEqual(await claim(), { work: null });
      const dispatches = (await events(work.runId)).filter((event) => event.from_status === "queued" && event.to_status === "dispatching");
      assert.equal(dispatches.length, 1, "exactly one dispatch of the logical run");
      // Submit never happened: the runner proves no job carries submitTag, then resubmits under the same tag.
      const second = await claimed();
      await expireLease(second.runId);
      const recon = (await claim()).work;
      assert.equal(recon.runId, second.runId);
      const notFound = await lab(runnerToken, { action: "reconcile", runId: second.runId, leaseEpoch: recon.leaseEpoch, found: false });
      assert.equal(notFound.status, "dispatching");
      await lab(runnerToken, { action: "complete", runId: second.runId, leaseEpoch: recon.leaseEpoch, outcome: "failed", exitCode: 2, manifest: null });
      await lab(runnerToken, { action: "complete", runId: work.runId, leaseEpoch: again.leaseEpoch, outcome: "failed", exitCode: 2, manifest: null });
      // R05: a submit with an unknown outcome is never "proven absent": the run fails for an operator.
      const unsure = await claimed();
      await expireLease(unsure.runId);
      const unsureRecon = (await claim()).work;
      const unknownBody = { action: "reconcile", runId: unsure.runId, leaseEpoch: unsureRecon.leaseEpoch };
      assert.equal((await lab(runnerToken, { ...unknownBody, found: true, schedulerJobId: "5", schedulerState: "running", submitOutcome: "unknown" }, 400)).error, "submitOutcome 无效");
      assert.equal((await lab(runnerToken, { ...unknownBody, found: false, submitOutcome: "lost" }, 400)).error, "submitOutcome 无效");
      const failed = await lab(runnerToken, { ...unknownBody, found: false, submitOutcome: "unknown" });
      assert.equal(failed.status, "failed");
      assert.equal(failed.repository, undefined, "no read token: nothing may be submitted");
      const unsureRow = await db.prepare("SELECT status, failure_reason, lease_expires_at FROM runs WHERE id = ?").bind(unsure.runId).first();
      assert.equal(unsureRow.status, "failed");
      assert.match(unsureRow.failure_reason, /^SUBMIT_OUTCOME_UNKNOWN: /);
      assert.equal(unsureRow.lease_expires_at, null);
      assert.ok(!(await events(unsure.runId)).some((event) => event.from_status === "reconciling" && event.to_status === "dispatching"));
      assert.deepEqual(await claim(), { work: null }, "never re-dispatched");
    });

    await t.test("cancel before dispatch, in flight, and after disconnect never revives a run (T13)", async () => {
      const waiting = await runs(createBody());
      assert.equal((await runs({ action: "cancel", runId: waiting.runId })).status, "canceled");
      const queued = await queuedRun();
      assert.equal((await runs({ action: "cancel", runId: queued.runId }, "mentor3")).status, "canceled");
      assert.deepEqual(await claim(), { work: null });
      await approve(waiting, "mentor1", 409);

      const inFlight = await claimed();
      await lab(runnerToken, { action: "heartbeat", runId: inFlight.runId, leaseEpoch: inFlight.leaseEpoch, phase: "running" });
      assert.equal((await runs({ action: "cancel", runId: inFlight.runId })).status, "cancel_requested");
      const hb = await lab(runnerToken, { action: "heartbeat", runId: inFlight.runId, leaseEpoch: inFlight.leaseEpoch, phase: "running" });
      assert.equal(hb.cancelRequested, true);
      assert.equal(await status(inFlight.runId), "cancel_requested");
      assert.equal((await lab(runnerToken, { action: "complete", runId: inFlight.runId, leaseEpoch: inFlight.leaseEpoch, outcome: "canceled", exitCode: null, manifest: null })).status, "canceled");

      // Disconnect: cancel recorded while the runner is gone; reconnect reconciles and kills the job.
      for (const found of [true, false]) {
        const work = await claimed();
        await lab(runnerToken, { action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running", schedulerJobId: "900" });
        await runs({ action: "cancel", runId: work.runId });
        await expireLease(work.runId);
        const recon = (await claim()).work;
        assert.equal(recon.mode, "reconcile");
        assert.equal(recon.runId, work.runId);
        const result = await lab(runnerToken, { action: "reconcile", runId: work.runId, leaseEpoch: recon.leaseEpoch, found, schedulerJobId: "900", schedulerState: found ? "running" : undefined });
        assert.equal(result.cancelRequested, true);
        if (found) {
          assert.equal(result.status, "cancel_requested");
          assert.equal((await lab(runnerToken, { action: "complete", runId: work.runId, leaseEpoch: recon.leaseEpoch, outcome: "canceled", exitCode: null, manifest: null })).status, "canceled");
        } else assert.equal(result.status, "canceled");
        assert.deepEqual(await claim(), { work: null });
        await runs({ action: "cancel", runId: work.runId }, "studentA", 409);
        assert.equal(await status(work.runId), "canceled");
        assert.ok(!(await events(work.runId)).some((event) => event.from_status === "canceled"), "no edge leaves canceled");
      }
    });

    await t.test("revoking grant, approval or student stops new work and cancels in-flight runs (T12)", async () => {
      const work = await claimed();
      await lab(runnerToken, { action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running" });
      const waiting = await queuedRun();
      await admin({ action: "revoke_dataset", datasetVersionId: dataset.id, studentId: "rs-a" });
      const hb = await lab(runnerToken, { action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running" });
      assert.equal(hb.cancelRequested, true);
      assert.equal(await status(work.runId), "cancel_requested");
      const audit = (await events(work.runId)).at(-1);
      assert.match(audit.payload_json, /authorization_revoked/);
      assert.match(audit.payload_json, /数据授权已撤销/);
      assert.deepEqual(await claim(), { work: null }, "queued run is not dispatched without an active grant");
      await runs(createBody(), "studentA", 403);
      await lab(runnerToken, { action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "canceled", exitCode: null, manifest: null });
      await admin({ action: "grant_dataset", datasetVersionId: dataset.id, studentId: "rs-a" });

      await db.prepare("UPDATE students SET active = 0 WHERE id = 'rs-a'").run();
      assert.deepEqual(await claim(), { work: null }, "inactive student gets no new work");
      await db.prepare("UPDATE students SET active = 1 WHERE id = 'rs-a'").run();

      await db.prepare("UPDATE mentor_student_assignments SET can_review = 0 WHERE mentor_user_id = 1103").run();
      assert.deepEqual(await claim(), { work: null }, "approver lost review rights");
      await db.prepare("UPDATE mentor_student_assignments SET can_review = 1 WHERE mentor_user_id = 1103").run();

      await runs({ action: "revoke_approval", runId: waiting.runId }, "studentA", 403);
      const revoked = await runs({ action: "revoke_approval", runId: waiting.runId }, "mentor2");
      assert.equal(revoked.status, "canceled");
      assert.deepEqual(await claim(), { work: null });
      const flying = await claimed();
      await runs({ action: "revoke_approval", runId: flying.runId }, "mentor2");
      const after = await lab(runnerToken, { action: "heartbeat", runId: flying.runId, leaseEpoch: flying.leaseEpoch, phase: "running" });
      assert.equal(after.cancelRequested, true);
      await lab(runnerToken, { action: "complete", runId: flying.runId, leaseEpoch: flying.leaseEpoch, outcome: "canceled", exitCode: null, manifest: null });
    });

    await t.test("manifest fields must match the approved spec exactly", async () => {
      const cases = [
        ["runSpecSha256", (m) => ({ ...m, runSpecSha256: "9".repeat(64) })],
        ["approvalId", (m) => ({ ...m, approvalId: "apr_forged" })],
        ["attempt", (m) => ({ ...m, attempt: m.attempt + 1 })],
        ["executedCommitSha", (m) => ({ ...m, repository: { ...m.repository, executedCommitSha: SHA_B } })],
        ["manifestSha256", (m) => ({ ...m, inputs: { ...m.inputs, manifestSha256: "8".repeat(64) } })],
        ["evaluationProtocolSha256", (m) => ({ ...m, inputs: { ...m.inputs, evaluationProtocolSha256: "7".repeat(64) } })],
        ["imageDigest", (m) => ({ ...m, environment: { ...m.environment, imageDigest: `sha256:${"6".repeat(64)}` } })],
        ["submitTag", (m) => ({ ...m, execution: { ...m.execution, submitTag: "tanyan-other" } })],
        ["schema", (m) => ({ ...m, schema: "other" })],
      ];
      for (const [field, mutate] of cases) {
        const work = await claimed();
        const items = [file("metrics.json", metricsContent(), { kind: "metrics" })];
        const rejected = await complete(work, items, { manifest: mutate(manifestFor(work, items)) }, 422);
        assert.match(rejected.code, /MANIFEST_(MISMATCH|INVALID)/, field);
        const row = await db.prepare("SELECT status, failure_reason FROM runs WHERE id = ?").bind(work.runId).first();
        assert.equal(row.status, "failed", field);
        assert.match(row.failure_reason, /MANIFEST_/);
        assert.equal((await db.prepare("SELECT count(*) AS n FROM run_results WHERE run_id = ?").bind(work.runId).first()).n, 0);
        assert.equal((await bucket.list({ prefix: `runs/${work.runId}/` })).objects.length, 0);
      }
      const missing = await claimed();
      assert.equal((await lab(runnerToken, { action: "complete", runId: missing.runId, leaseEpoch: missing.leaseEpoch, outcome: "completed", exitCode: 0, manifest: null }, 422)).code, "MANIFEST_REQUIRED");
    });

    await t.test("egress is re-applied: only downgrades, traversal rejected, nothing held reaches R2 (T17)", async () => {
      const work = await claimed();
      const ok = file("summary.json", "{\"ok\":true}");
      const items = [
        file("metrics.json", metricsContent(), { kind: "metrics" }),
        ok,
        file("../escape.json", "{}"),
        file("/etc/passwd.txt", "root"),
        file("a/./b.json", "{}"),
        file("plot.png", "PNGDATA", { kind: "figure" }),
        file("big.json", "x".repeat(1200)),
        file("weights.bin", "binary", { kind: "model" }),
        file("forged.txt", "real content", { sha: sha256("other content") }),
        file("held.json", "{}", { decision: "held" }),
        file("dataset-copy.csv", "raw", { decision: "rejected" }),
      ];
      const done = await complete(work, items);
      const decisions = Object.fromEntries(done.artifacts.map((item) => [item.relativePath, item.egressDecision]));
      assert.deepEqual(decisions, {
        "metrics.json": "published", "summary.json": "published", "../escape.json": "rejected", "/etc/passwd.txt": "rejected",
        "a/./b.json": "rejected", "plot.png": "held", "big.json": "held", "weights.bin": "held", "forged.txt": "held",
        "held.json": "held", "dataset-copy.csv": "rejected",
      });
      const stored = (await bucket.list({ prefix: `runs/${work.runId}/` })).objects.map((object) => object.key).sort();
      assert.deepEqual(stored, [`runs/${work.runId}/metrics.json`, `runs/${work.runId}/summary.json`]);
      const view = await detail(work.runId);
      for (const artifact of view.artifacts.filter((item) => item.egressDecision !== "published")) {
        assert.equal(artifact.downloadable, false);
        await expectJson(await call(`/api/run-artifacts?artifactId=${artifact.id}`, { actor: "root" }), 404);
      }
      assert.match(view.artifacts.find((item) => item.relativePath === "plot.png").egressReason, /图片/);
    });

    await t.test("contract: hashless entries only when rejected; unknown exit code is null and compared null-aware", async () => {
      // Rejected symlink/special file: the runner never opens it, so sha256 is "".
      const work = await claimed();
      const symlink = { artifact: { relativePath: "data-link", sha256: "", sizeBytes: 0, kind: "other", egressDecision: "rejected", egressReason: "symbolic link (not followed)", labLocator: "lab://out/data-link" } };
      const done = await complete(work, [file("metrics.json", metricsContent(), { kind: "metrics" }), symlink], { published: [file("metrics.json", metricsContent(), { kind: "metrics" })] });
      assert.equal(done.status, "completed");
      const row = await db.prepare("SELECT sha256, egress_decision, r2_key FROM run_artifacts WHERE run_id = ? AND relative_path = 'data-link'").bind(work.runId).first();
      assert.deepEqual(row, { sha256: "", egress_decision: "rejected", r2_key: null });
      assert.equal((await detail(work.runId)).result.technicalValidity, "valid");
      // "" is not a hash for anything that could be published or held.
      const held = await claimed();
      const heldEntry = { artifact: { ...symlink.artifact, egressDecision: "held" } };
      assert.equal((await complete(held, [heldEntry], { metricsArtifactPath: null, published: [] }, 422)).code, "MANIFEST_INVALID");

      // Unknown exit code: null in both places is accepted and never valid.
      const unknown = await claimed();
      const metrics = file("metrics.json", metricsContent(), { kind: "metrics" });
      const unknownDone = await complete(unknown, [metrics], { exitCode: null, manifest: manifestFor(unknown, [metrics], { exitCode: null }) });
      assert.equal(unknownDone.technicalValidity, "invalid");
      const view = await detail(unknown.runId);
      assert.equal(view.run.exitCode, null);
      assert.equal(view.result.manifest.execution.exitCode, null);
      assert.match(view.result.validityNotes, /退出码未知/);
      // Null-aware equality: null must not match a number either way.
      for (const [top, inManifest] of [[0, null], [null, 0]]) {
        const mismatch = await claimed();
        const rejected = await complete(mismatch, [metrics], { exitCode: top, manifest: manifestFor(mismatch, [metrics], { exitCode: inManifest }) }, 422);
        assert.equal(rejected.code, "MANIFEST_MISMATCH");
      }

      // Reconcile response (ComputeReconcileResponse): leaseExpiresAt is always a string.
      const lost = await claimed();
      await expireLease(lost.runId);
      const recon = (await claim()).work;
      assert.equal(recon.mode, "reconcile");
      const answer = await lab(runnerToken, { action: "reconcile", runId: lost.runId, leaseEpoch: recon.leaseEpoch, found: true, schedulerJobId: "77", schedulerState: "failed" });
      assert.deepEqual(Object.keys(answer).sort(), ["cancelRequested", "leaseExpiresAt", "status"]);
      assert.equal(answer.status, "failed");
      assert.equal(typeof answer.leaseExpiresAt, "string");
      assert.equal(answer.cancelRequested, false);
    });

    const resultFor = async (items, options = {}) => {
      const work = await claimed();
      const done = await complete(work, items, options);
      return { work, done, view: await detail(work.runId) };
    };
    await t.test("missing or invalid metrics are never acceptable (T19/T20) and protocol drift is flagged (T21)", async () => {
      const none = await resultFor([file("log.txt", "trained", { kind: "log" })], { metricsArtifactPath: null });
      assert.equal(none.view.result.technicalValidity, "unknown");
      assert.equal(none.view.result.metrics, null);
      const refused = await results({ action: "review", runId: none.work.runId, expectedVersion: 1, state: "accepted", hypothesisOutcome: "supported" }, "mentor1", 409);
      assert.equal(refused.code, "NOT_TECHNICALLY_VALID");
      await results({ action: "review", runId: none.work.runId, expectedVersion: 1, state: "needs_followup", hypothesisOutcome: "inconclusive", note: "缺少评测" });

      const broken = await resultFor([file("metrics.json", "{not json", { kind: "metrics" })]);
      assert.equal(broken.view.result.technicalValidity, "invalid");
      assert.match(broken.view.result.validityNotes, /JSON/);
      const schemaBad = await resultFor([file("metrics.json", JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: EVAL, split: "test", values: { acc: "0.99" } }), { kind: "metrics" })]);
      assert.equal(schemaBad.view.result.technicalValidity, "invalid");
      assert.equal(schemaBad.view.result.metrics, null);
      // T20: a claimed metrics file that never left the lab is not formal evidence.
      const notUploaded = await resultFor([file("metrics.json", metricsContent(), { kind: "metrics" })], { published: [] });
      assert.equal(notUploaded.view.result.technicalValidity, "invalid");
      assert.equal(notUploaded.view.result.metrics, null);
      assert.match(notUploaded.view.result.validityNotes, /未外发/);
      const failedExit = await resultFor([file("metrics.json", metricsContent(), { kind: "metrics" })], { outcome: "failed", exitCode: 3 });
      assert.equal(failedExit.view.run.status, "failed");
      assert.equal(failedExit.view.result.technicalValidity, "invalid");
      const drift = await resultFor([file("metrics.json", metricsContent("5".repeat(64)), { kind: "metrics" })]);
      assert.equal(drift.view.result.technicalValidity, "invalid");
      assert.equal(drift.view.result.metrics, null);
      assert.match(drift.view.result.validityNotes, /评价协议不一致/);
      await results({ action: "review", runId: drift.work.runId, expectedVersion: 1, state: "accepted", hypothesisOutcome: "supported" }, "mentor1", 409);
    });

    await t.test("rerun creates a new attempt that needs approval and keeps the failed history (T23)", async () => {
      const work = await claimed({ params: { lr: 0.42 } });
      await lab(runnerToken, { action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "failed", exitCode: 137, failureReason: "OOM", manifest: null });
      const before = await events(work.runId);
      const idempotencyKey = key("rerun");
      const rerun = await runs({ action: "rerun", runId: work.runId, idempotencyKey });
      assert.equal((await runs({ action: "rerun", runId: work.runId, idempotencyKey })).runId, rerun.runId);
      assert.equal(rerun.runSpecSha256, work.runSpecSha256);
      assert.equal(rerun.attempt, work.attempt + 1);
      assert.equal(rerun.status, "awaiting_approval");
      assert.notEqual(rerun.runId, work.runId);
      assert.deepEqual(await claim(), { work: null }, "the old approval does not carry over");
      const old = await db.prepare("SELECT status, exit_code, failure_reason, approval_id FROM runs WHERE id = ?").bind(work.runId).first();
      assert.deepEqual({ ...old, approval_id: Boolean(old.approval_id) }, { status: "failed", exit_code: 137, failure_reason: "OOM", approval_id: true });
      assert.deepEqual(await events(work.runId), before);
      await approve(rerun);
      const next = (await claim()).work;
      assert.equal(next.runId, rerun.runId);
      assert.equal(next.attempt, work.attempt + 1);
      assert.notEqual(next.approvalId, work.approvalId);
      await runs({ action: "rerun", runId: rerun.runId, idempotencyKey: key("rerun") }, "studentA", 409);
      await lab(runnerToken, { action: "complete", runId: next.runId, leaseEpoch: next.leaseEpoch, outcome: "failed", exitCode: 1, manifest: null });
    });

    await t.test("comments are idempotent and scoped; follow-up tasks link back to the run (T25)", async () => {
      const runId = completedWork.runId;
      const requestId = key("comment");
      const first = await results({ action: "comment", runId, requestId, body: "指标看起来合理" }, "studentA");
      const replay = await results({ action: "comment", runId, requestId, body: "指标看起来合理" }, "studentA");
      assert.equal(replay.comment.id, first.comment.id);
      await results({ action: "comment", runId, requestId, body: "冒用" }, "mentor1", 409);
      await results({ action: "comment", runId, requestId: key("comment"), body: "越权" }, "studentB", 403);
      const reply = await results({ action: "comment", runId, requestId: key("comment"), body: "同意", parentCommentId: first.comment.id }, "mentor1");
      assert.equal(reply.comment.parentCommentId, first.comment.id);
      const otherRun = (await db.prepare("SELECT id FROM runs WHERE id <> ? AND status = 'failed' LIMIT 1").bind(runId).first()).id;
      await results({ action: "comment", runId: otherRun, requestId: key("comment"), body: "错挂", parentCommentId: first.comment.id }, "mentor1", 400);

      const content = { title: "后续：消融实验", researchQuestion: "去掉模块 X 是否影响结果", instructions: "只修改 src/model", acceptanceCriteria: "同协议指标", budget: { maxGpuCount: 1 } };
      await results({ action: "followup", runId, mutationId: key("follow"), ...content }, "studentB", 403);
      const mutationId = key("follow");
      const follow = await results({ action: "followup", runId, mutationId, ...content }, "mentor1");
      const again = await results({ action: "followup", runId, mutationId, ...content }, "mentor1");
      assert.equal(again.taskId, follow.taskId);
      assert.equal(again.replayed, true);
      assert.equal(follow.linkedOnReview, true);
      const task = await db.prepare("SELECT student_id, source_run_id, parent_task_id, status FROM research_tasks WHERE id = ?").bind(follow.taskId).first();
      assert.deepEqual(task, { student_id: "rs-a", source_run_id: runId, parent_task_id: "task_rsa", status: "draft" });
      const view = await detail(runId);
      assert.equal(view.review.followupTaskId, follow.taskId);
      assert.equal(view.comments.length, 2);
      assert.equal(view.review.state, "accepted", "follow-up does not change the review decision");
    });

    await t.test("concurrent approvals, claims and cancels apply exactly once (optimistic guards)", async () => {
      const run = await runs(createBody({ params: { lr: 0.55 } }));
      const approvals = await Promise.all(["mentor1", "mentor2", "root"].map((actor) =>
        call("/api/runs", { actor, method: "POST", body: { action: "approve", runId: run.runId, runSpecSha256: run.runSpecSha256 } })));
      assert.deepEqual(approvals.map((response) => response.status).sort(), [200, 409, 409]);
      for (const response of approvals) await response.text();
      assert.equal((await db.prepare("SELECT count(*) AS n FROM run_approvals WHERE run_spec_sha256 = ?").bind(run.runSpecSha256).first()).n, 1);
      const claims = await Promise.all([claim(), claim(), claim()]);
      assert.equal(claims.filter((item) => item.work).length, 1);
      const work = claims.find((item) => item.work).work;
      const cancels = await Promise.all([1, 2, 3].map(() => call("/api/runs", { actor: "studentA", method: "POST", body: { action: "cancel", runId: work.runId } })));
      // A loser either sees cancel_requested (idempotent 200) or loses the guard (409), never a second transition.
      const cancelStatuses = await Promise.all(cancels.map(async (response) => { await response.text(); return response.status; }));
      assert.ok(cancelStatuses.includes(200) && cancelStatuses.every((code) => code === 200 || code === 409), String(cancelStatuses));
      const toCancel = (await events(work.runId)).filter((event) => event.to_status === "cancel_requested");
      assert.equal(toCancel.length, 1);
      await lab(runnerToken, { action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "canceled", exitCode: null, manifest: null });
      const sequences = (await events(work.runId)).map((event) => event.sequence);
      assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
    });

    await t.test("detail exposes permissions and nothing left the sandbox", async () => {
      const waiting = await runs(createBody({ params: { lr: 0.77 } }));
      const forMentor = await detail(waiting.runId, "mentor1");
      assert.equal(forMentor.permissions.canApprove, true);
      assert.equal(forMentor.permissions.canCancel, true);
      const forStudent = await detail(waiting.runId, "studentA");
      assert.equal(forStudent.permissions.canApprove, false);
      assert.equal(forStudent.spec.entrypoint.argv[0], "python");
      await runs({ action: "cancel", runId: waiting.runId });
      const foreign = await call("/api/runs", { actor: "studentA", method: "POST", body: { action: "cancel", runId: waiting.runId }, headers: { origin: "https://evil.example" } });
      assert.equal(foreign.status, 403);
      await foreign.text();
      assert.equal(outbound, 0, "no external requests");
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
  } finally {
    await mf.dispose();
  }
});
