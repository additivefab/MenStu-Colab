import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Batch 6 adversarial rules (independent of the implementation, derived from
// the contracts only):
//   G3 — evaluation budget per task version + evaluation protocol
//        (TaskBudget.maxFormalEvaluations, EvaluationBudgetView) and
//        reproduction checks between executions of one run spec
//        (TaskBudget.reproTolerance, ReproductionView), pack 02 §9.
//   G2 — compensating reconciliation: POST /api/admin/maintenance
//        { action: "run" | "dry_run" }, superadmin only.
// Every fixture is synthetic; outbound network is refused and counted. The lab
// runner is simulated by direct protocol calls.

// ---------------------------------------------------------------------------
// Configurable thresholds for the maintenance job. The implementation's exact
// cut-offs may differ (brief: ~30 min without heartbeat), so fixtures sit far
// beyond (STALE) and far within (FRESH) them.
// ---------------------------------------------------------------------------
const STALE_AGO_MS = 6 * 60 * 60 * 1000; // well beyond any heartbeat threshold
const FRESH_AGO_MS = 2 * 60 * 1000; // well within any heartbeat threshold
const ACTIVE_LEASE_AHEAD_MS = 20 * 60 * 1000; // lease clearly still active
const DEFAULT_REPRO_TOLERANCE = 0.01;
const FLOAT_EPSILON = 1e-9;

const EVAL_A = "e".repeat(64);
const EVAL_B = "f".repeat(64);
const DATA_MANIFEST = "a".repeat(64);
const SPLIT_MANIFEST = "b".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `registry.lab/train@${IMAGE_DIGEST}`;
const SHA_HEAD = "3".repeat(40);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const isoAhead = (ms) => new Date(Date.now() + ms).toISOString();

test("batch 6 rules: evaluation budget, reproduction checks and compensating reconciliation", { timeout: 300_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "batch6-rules-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const personas = { student: "student", other: "student" };
  const cookie = (actor) => actor ? `tanyan_session=b6-${actor}; tanyan_persona=${personas[actor] ?? "management"}` : "";
  const call = (path, { actor, method = "GET", body, headers = {} } = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { cookie: cookie(actor), ...(body ? { "content-type": "application/json", origin } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const expectJson = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text.slice(0, 500));
    return JSON.parse(text);
  };
  const admin = (body) => call("/api/admin/lab", { actor: "root", method: "POST", body }).then((r) => expectJson(r));
  const runs = (body, actor = "student", status = 200) => call("/api/runs", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const detail = (runId, actor = "student") => call(`/api/runs?runId=${runId}`, { actor }).then((r) => expectJson(r));
  const maintenance = (body, actor = "root", extra = {}) => call("/api/admin/maintenance", { actor, method: "POST", body, ...extra });
  let runnerToken;
  const lab = (body, status = 200) => mf.dispatchFetch(origin + "/api/lab/runs", {
    method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => expectJson(r, status));
  let keyCounter = 0;
  const key = (label = "k") => `${label}-${String(++keyCounter).padStart(6, "0")}`;

  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('b6-a', '批六学生甲', '博士', 2025, '实验', 1), ('b6-b', '批六学生乙', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (6101, 'b6-student', '批六学生甲', 'student', 'b6-a'), (6102, 'b6-other', '批六学生乙', 'student', 'b6-b'),
      (6103, 'b6-mentor', '批六导师', 'mentor', NULL), (6106, 'b6-root', '批六超级管理员', 'superadmin', NULL)`).run();
    await db.prepare("INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES (6103, 'b6-a', 1, 1)").run();
    for (const [id, actor] of [[6101, "student"], [6102, "other"], [6103, "mentor"], [6106, "root"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`b6-${actor}`), id).run();
    }
    await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (66, 'synthetic-lab', 'Organization')").run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch)
      VALUES ('b6-a', 6601, 66, 'synthetic-lab/b6-a', 'main')`).run();
    await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_b6agent', '代理', 'agent', ?)").bind("9".repeat(64)).run();
    await db.prepare("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_b6', 6101, 'codex', 'rnr_b6agent')").run();

    // A confirmed task (version 1) with its own published change request.
    let snapshotCounter = 0;
    const snapshotHash = () => sha256(`snapshot-${++snapshotCounter}`);
    const seedTask = async (taskId, budget) => {
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
        VALUES (?, 'b6-a', '批六任务', 'confirmed', 1, 1, 6101, ?, ?)`).bind(taskId, `seed-${taskId}`, `seed-${taskId}`).run();
      await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
        budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
        VALUES (?, 1, '批六任务', '合成问题', '合成说明', '合成标准', ?, ?, 6101, 6101, CURRENT_TIMESTAMP)`)
        .bind(taskId, JSON.stringify(budget), snapshotHash()).run();
      await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
        base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
        VALUES (?, ?, 1, 'b6-a', 'codex', 'cred_b6', 6601, ?, ?, 'change_ready', ?, 6101)`)
        .bind(`att_cr_${taskId}`, taskId, "0".repeat(40), "d".repeat(64), `seed-att-${taskId}`).run();
      await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, status)
        VALUES (?, ?, ?, 'b6-a', 6601, ?, ?, ?, 'open')`)
        .bind(`cr_${taskId}`, taskId, `att_cr_${taskId}`, "0".repeat(40), `tanyan/${taskId}/seed`, SHA_HEAD).run();
    };
    // Confirms a new task version directly (the task editor is not under test).
    const confirmVersion = async (taskId, version, budget) => {
      await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
        budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
        VALUES (?, ?, '批六任务', '合成问题', '新版本说明', '合成标准', ?, ?, 6101, 6101, CURRENT_TIMESTAMP)`)
        .bind(taskId, version, JSON.stringify(budget), snapshotHash()).run();
      await db.prepare("UPDATE research_tasks SET current_version = ?, confirmed_version = ? WHERE id = ?").bind(version, version, taskId).run();
    };

    // Lab registry through the admin API: one compute runner, two entrypoints
    // that differ only in their evaluation protocol, one granted dataset.
    const registered = await admin({ action: "register_runner", label: "批六 GPU", kind: "compute" });
    runnerToken = registered.token;
    const runnerId = registered.runner.id;
    const paramsSchema = { lr: { type: "number", required: true, minimum: 0, maximum: 1 } };
    const entryA = (await admin({ action: "register_entrypoint", studentId: "b6-a", name: "eval-a", argv: ["python", "train.py"], imageRef: IMAGE,
      evaluationProtocolSha256: EVAL_A, paramsSchema })).entrypoint;
    const entryB = (await admin({ action: "register_entrypoint", studentId: "b6-a", name: "eval-b", argv: ["python", "train.py"], imageRef: IMAGE,
      evaluationProtocolSha256: EVAL_B, paramsSchema })).entrypoint;
    const policy = { schema: "tanyan.egress/v1", allowedExtensions: [".json", ".txt"], maxFileBytes: 10_000, maxTotalBytes: 50_000, allowImages: false, blockDatasetHashMatches: true };
    const dataset = (await admin({ action: "register_dataset", label: "批六数据", runnerId, manifestSha256: DATA_MANIFEST, splitManifestSha256: SPLIT_MANIFEST, egressPolicy: policy })).dataset;
    await admin({ action: "grant_dataset", datasetVersionId: dataset.id, studentId: "b6-a" });

    let lrCounter = 0;
    const nextLr = () => Number((0.001 * ++lrCounter).toFixed(3));
    const createBody = (taskId, overrides = {}) => ({
      action: "create", taskId, changeRequestId: `cr_${taskId}`, entrypointId: entryA.id, params: { lr: nextLr() },
      datasetVersionId: dataset.id, resources: { gpuCount: 1, walltimeMinutes: 60, memoryGb: 16 }, idempotencyKey: key("create"), ...overrides,
    });
    const create = (taskId, overrides = {}, status = 200) => runs(createBody(taskId, overrides), "student", status);
    const rerun = (runId, status = 200, idempotencyKey = key("rerun")) => runs({ action: "rerun", runId, idempotencyKey }, "student", status);
    const approve = (run) => runs({ action: "approve", runId: run.runId, runSpecSha256: run.runSpecSha256 }, "mentor");
    const cancel = (runId) => runs({ action: "cancel", runId });
    const claimFor = async (run) => {
      const { work } = await lab({ action: "claim" });
      assert.equal(work?.runId, run.runId, "the only queued run is claimed");
      return work;
    };
    const metricsFile = (values, protocol) => {
      const content = JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: protocol, split: "test", values });
      return {
        artifact: { relativePath: "metrics.json", sha256: sha256(content), sizeBytes: Buffer.byteLength(content), kind: "metrics", egressDecision: "published", egressReason: "runner", labLocator: "lab://out/metrics.json" },
        published: { relativePath: "metrics.json", contentBase64: Buffer.from(content).toString("base64") },
      };
    };
    const manifestFor = (work, items) => ({
      schema: "tanyan.manifest/v1", runId: work.runId, attempt: work.attempt, runSpecSha256: work.runSpecSha256, approvalId: work.approvalId,
      repository: { repositoryId: work.spec.repository.repositoryId, executedCommitSha: work.spec.executedCommitSha },
      inputs: { datasetVersionId: work.spec.dataset.versionId, manifestSha256: work.spec.dataset.manifestSha256,
        splitManifestSha256: work.spec.dataset.splitManifestSha256, evaluationProtocolSha256: work.spec.evaluationProtocolSha256, seeds: [7] },
      environment: { imageDigest: IMAGE_DIGEST, driverVersion: "550.00", gpuModel: "synthetic" },
      execution: { runnerId, schedulerJobId: "6060", submitTag: work.submitTag, entrypointId: work.spec.entrypoint.id,
        startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T01:00:00Z", exitCode: 0 },
      metricsArtifactPath: "metrics.json", artifacts: items.map((item) => item.artifact),
    });
    /** Approve, claim and complete `run` with formal metrics; returns the detail. */
    const completeWith = async (run, values) => {
      await approve(run);
      const work = await claimFor(run);
      const items = [metricsFile(values, work.spec.evaluationProtocolSha256)];
      const done = await lab({ action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "completed", exitCode: 0,
        manifest: manifestFor(work, items), publishedFiles: items.map((item) => item.published) });
      assert.equal(done.status, "completed");
      assert.equal(done.technicalValidity, "valid");
      return detail(run.runId);
    };
    const failDispatched = async (run) => {
      await approve(run);
      const work = await claimFor(run);
      await lab({ action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "failed", exitCode: 1, manifest: null });
      return work;
    };
    const exhausted = (body) => assert.equal(body.code, "EVALUATION_BUDGET_EXHAUSTED", JSON.stringify(body));
    const budgetOf = async (runId) => {
      const view = (await detail(runId)).evaluationBudget;
      assert.ok(view, "RunDetail.evaluationBudget is present");
      return view;
    };
    const runCount = async (taskId) => (await db.prepare("SELECT count(*) AS n FROM runs WHERE task_id = ?").bind(taskId).first()).n;

    // -----------------------------------------------------------------------
    // G3: evaluation budget
    // -----------------------------------------------------------------------
    await t.test("budget counts awaiting, failed, reruns and canceled-after-dispatch; not canceled-before-dispatch", async () => {
      await seedTask("task_cnt", { maxGpuCount: 2, maxWalltimeMinutes: 600, maxFormalEvaluations: 3 });
      const r1 = await create("task_cnt");
      assert.deepEqual(await budgetOf(r1.runId), { taskVersion: 1, evaluationProtocolSha256: EVAL_A, used: 1, limit: 3, remaining: 2 },
        "an awaiting run is not canceled, so it counts");
      // Canceled before dispatch: from awaiting_approval and from queued.
      await cancel(r1.runId);
      assert.equal((await budgetOf(r1.runId)).used, 0, "canceled while awaiting approval does not count");
      const r2 = await create("task_cnt");
      await approve(r2);
      assert.equal((await cancel(r2.runId)).status, "canceled");
      assert.equal((await budgetOf(r2.runId)).used, 0, "canceled while queued does not count");
      // Failed after dispatch counts; its rerun counts too.
      const r3 = await create("task_cnt");
      await failDispatched(r3);
      assert.equal((await budgetOf(r3.runId)).used, 1, "failed runs count");
      const replayKey = key("replay");
      const r4 = await rerun(r3.runId, 200, replayKey);
      assert.equal(r4.attempt, 2);
      assert.equal((await budgetOf(r4.runId)).used, 2, "reruns of a spec count");
      // Dispatched, then canceled: counts.
      const r5 = await create("task_cnt");
      await approve(r5);
      const work = await claimFor(r5);
      await lab({ action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running" });
      assert.equal((await cancel(r5.runId)).status, "cancel_requested");
      await lab({ action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "canceled", exitCode: null, manifest: null });
      assert.deepEqual(await budgetOf(r5.runId), { taskVersion: 1, evaluationProtocolSha256: EVAL_A, used: 3, limit: 3, remaining: 0 },
        "a run canceled after dispatch counts");

      // Exhausted: create and rerun are refused with 409, nothing is written.
      const before = await runCount("task_cnt");
      exhausted(await create("task_cnt", {}, 409));
      exhausted(await rerun(r3.runId, 409));
      assert.equal(await runCount("task_cnt"), before, "a refused creation leaves no run row");
      // An idempotent replay of an accepted creation is still a replay, not a refusal.
      const replay = await rerun(r3.runId, 200, replayKey);
      assert.equal(replay.runId, r4.runId);
      assert.equal(replay.replayed, true);

      // Freeing a slot (cancel the awaiting rerun) allows exactly one more.
      await cancel(r4.runId);
      assert.equal((await budgetOf(r3.runId)).used, 2);
      const r6 = await create("task_cnt");
      assert.equal((await budgetOf(r6.runId)).remaining, 0);
      exhausted(await create("task_cnt", {}, 409));
    });

    await t.test("budgets are separate per evaluation protocol", async () => {
      await seedTask("task_proto", { maxFormalEvaluations: 2 });
      await create("task_proto");
      await create("task_proto");
      exhausted(await create("task_proto", {}, 409));
      const b1 = await create("task_proto", { entrypointId: entryB.id });
      assert.deepEqual(await budgetOf(b1.runId), { taskVersion: 1, evaluationProtocolSha256: EVAL_B, used: 1, limit: 2, remaining: 1 });
      await create("task_proto", { entrypointId: entryB.id });
      exhausted(await create("task_proto", { entrypointId: entryB.id }, 409));
      exhausted(await create("task_proto", {}, 409));
    });

    await t.test("budgets are separate per task version and read from that version", async () => {
      await seedTask("task_ver", { maxFormalEvaluations: 1 });
      const v1 = await create("task_ver");
      exhausted(await create("task_ver", {}, 409));
      await confirmVersion("task_ver", 2, { maxFormalEvaluations: 2 });
      const v2a = await create("task_ver");
      assert.deepEqual(await budgetOf(v2a.runId), { taskVersion: 2, evaluationProtocolSha256: EVAL_A, used: 1, limit: 2, remaining: 1 },
        "version 1 runs do not count against version 2");
      const v1View = await budgetOf(v1.runId);
      assert.equal(v1View.taskVersion, 1);
      assert.equal(v1View.used, 1);
      assert.equal(v1View.limit, 1);
      await create("task_ver");
      exhausted(await create("task_ver", {}, 409));
      // No maxFormalEvaluations: unlimited, limit and remaining are null.
      await confirmVersion("task_ver", 3, { maxGpuCount: 2 });
      const v3 = await create("task_ver");
      const v3View = await budgetOf(v3.runId);
      assert.equal(v3View.taskVersion, 3);
      assert.equal(v3View.used, 1);
      assert.equal(v3View.limit, null);
      assert.equal(v3View.remaining, null);
    });

    await t.test("concurrent creations never exceed the budget", async () => {
      const LIMIT = 3;
      const ATTEMPTS = 10;
      await seedTask("task_conc", { maxFormalEvaluations: LIMIT });
      const responses = await Promise.all(Array.from({ length: ATTEMPTS }, () =>
        call("/api/runs", { actor: "student", method: "POST", body: createBody("task_conc") })));
      const outcomes = await Promise.all(responses.map(async (response) => ({ status: response.status, body: JSON.parse(await response.text()) })));
      const accepted = outcomes.filter((item) => item.status === 200);
      assert.ok(accepted.length >= 1 && accepted.length <= LIMIT, `accepted ${accepted.length} of ${ATTEMPTS}`);
      for (const item of outcomes.filter((entry) => entry.status !== 200)) {
        assert.equal(item.status, 409, JSON.stringify(item.body));
      }
      assert.ok(outcomes.some((item) => item.body.code === "EVALUATION_BUDGET_EXHAUSTED"));
      assert.equal(await runCount("task_conc"), accepted.length, "only accepted creations left rows");
      // Fill sequentially: the total settles at exactly the limit.
      while (await runCount("task_conc") < LIMIT) await create("task_conc");
      exhausted(await create("task_conc", {}, 409));
      assert.equal(await runCount("task_conc"), LIMIT);
      // Concurrent reruns of one failed run are bounded the same way.
      await seedTask("task_conc2", { maxFormalEvaluations: 2 });
      const source = await create("task_conc2");
      await failDispatched(source);
      const reruns = await Promise.all(Array.from({ length: 6 }, () =>
        call("/api/runs", { actor: "student", method: "POST", body: { action: "rerun", runId: source.runId, idempotencyKey: key("crerun") } })));
      const rerunStatuses = await Promise.all(reruns.map(async (response) => { await response.text(); return response.status; }));
      assert.ok(rerunStatuses.every((code) => code === 200 || code === 409), String(rerunStatuses));
      assert.ok(await runCount("task_conc2") <= 2, "used never exceeds the limit under concurrent reruns");
    });

    // -----------------------------------------------------------------------
    // G3: reproduction
    // -----------------------------------------------------------------------
    const assertMetric = (entry, name, current, previous, tolerance) => {
      assert.equal(entry.name, name);
      assert.ok(Math.abs(entry.current - current) < FLOAT_EPSILON, `${name} current`);
      assert.ok(Math.abs(entry.previous - previous) < FLOAT_EPSILON, `${name} previous`);
      assert.ok(Math.abs(Math.abs(entry.diff) - Math.abs(current - previous)) < FLOAT_EPSILON, `${name} diff`);
      assert.equal(entry.withinTolerance, Math.abs(current - previous) <= tolerance, `${name} withinTolerance`);
    };

    await t.test("reproduction compares with the previous completed execution of the same spec", async () => {
      await seedTask("task_rep", { maxGpuCount: 2 });
      const params = { lr: 0.5 };
      const run1 = await create("task_rep", { params });
      const view1 = await completeWith(run1, { accuracy: 0.91, loss: 0.30 });
      assert.equal(view1.reproduction ?? null, null, "attempt 1 has nothing to compare with");

      // Attempt 2: within the default tolerance; only shared metrics compared.
      const run2 = await rerun(run1.runId);
      const view2 = await completeWith(run2, { accuracy: 0.915, f1: 0.5 });
      const rep2 = view2.reproduction;
      assert.ok(rep2, "reproduction present for attempt 2");
      assert.equal(rep2.comparedRunId, run1.runId);
      assert.equal(rep2.comparedAttempt, 1);
      assert.equal(rep2.tolerance, DEFAULT_REPRO_TOLERANCE, "absent reproTolerance = 0.01");
      assert.deepEqual(rep2.metrics.map((item) => item.name), ["accuracy"], "loss and f1 are not in both");
      assertMetric(rep2.metrics[0], "accuracy", 0.915, 0.91, DEFAULT_REPRO_TOLERANCE);
      assert.equal(rep2.reproduced, true);

      // Attempt 3: compares with attempt 2 (the latest), outside tolerance.
      const run3 = await rerun(run2.runId);
      const rep3 = (await completeWith(run3, { accuracy: 0.95, loss: 0.30 })).reproduction;
      assert.equal(rep3.comparedRunId, run2.runId, "the previous execution, not the first");
      assert.equal(rep3.comparedAttempt, 2);
      assert.deepEqual(rep3.metrics.map((item) => item.name), ["accuracy"], "loss is absent in attempt 2");
      assertMetric(rep3.metrics[0], "accuracy", 0.95, 0.915, DEFAULT_REPRO_TOLERANCE);
      assert.equal(rep3.metrics[0].withinTolerance, false);
      assert.equal(rep3.reproduced, false);

      // Attempt 4 fails; attempt 5 skips it and has no metric in common.
      const run4 = await rerun(run3.runId);
      await failDispatched(run4);
      const run5 = await rerun(run4.runId);
      const rep5 = (await completeWith(run5, { precision: 0.7 })).reproduction;
      assert.ok(rep5, "reproduction present even when nothing is comparable");
      assert.equal(rep5.comparedRunId, run3.runId, "failed attempts are not completed executions");
      assert.equal(rep5.comparedAttempt, 3);
      assert.deepEqual(rep5.metrics, []);
      assert.equal(rep5.reproduced, false, "nothing comparable is never reproduced");

      // A different spec on the same task is not an earlier execution.
      const other = await create("task_rep", { params: { lr: 0.25 } });
      const otherView = await completeWith(other, { accuracy: 0.915 });
      assert.equal(otherView.reproduction ?? null, null, "attempt 1 of a new spec");
    });

    await t.test("reproduction uses the task's reproTolerance when set", async () => {
      await seedTask("task_tol", { reproTolerance: 0.05 });
      const run1 = await create("task_tol", { params: { lr: 0.5 } });
      await completeWith(run1, { accuracy: 0.90 });
      const run2 = await rerun(run1.runId);
      const rep = (await completeWith(run2, { accuracy: 0.93 })).reproduction;
      assert.equal(rep.tolerance, 0.05);
      assertMetric(rep.metrics[0], "accuracy", 0.93, 0.90, 0.05);
      assert.equal(rep.metrics[0].withinTolerance, true, "0.03 is within 0.05 (it would fail at the 0.01 default)");
      assert.equal(rep.reproduced, true);
    });

    // -----------------------------------------------------------------------
    // G2: compensating reconciliation
    // -----------------------------------------------------------------------
    await t.test("maintenance is superadmin-only and validates the action", async () => {
      for (const actor of ["student", "other", "mentor"]) {
        const response = await maintenance({ action: "dry_run" }, actor);
        assert.equal(response.status, 403, `${actor}: ${await response.text()}`);
      }
      const anonymous = await maintenance({ action: "dry_run" }, null);
      assert.ok([401, 403].includes(anonymous.status), `anonymous: ${anonymous.status}`);
      await anonymous.text();
      const foreign = await maintenance({ action: "run" }, "root", { headers: { origin: "https://evil.example" } });
      assert.equal(foreign.status, 403);
      await foreign.text();
      for (const body of [{ action: "nuke" }, {}]) {
        const response = await maintenance(body);
        assert.equal(response.status, 400, await response.text());
      }
    });

    const snapshot = async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
    const snapshotAll = async () => ({
      runs: await snapshot("runs"), run_events: await snapshot("run_events"),
      agent_attempts: await snapshot("agent_attempts"), agent_attempt_events: await snapshot("agent_attempt_events"),
    });
    const rowOf = (rows, id) => rows.find((row) => row.id === id);
    const eventsOf = (rows, field, id) => rows.filter((row) => row[field] === id);

    let fixtures;
    await t.test("maintenance fixtures: stale/fresh cancel requests, active leases, expired agent leases", async () => {
      await seedTask("task_mnt", { maxGpuCount: 2 });
      const inFlight = async ({ cancelRequested }) => {
        const run = await create("task_mnt");
        await approve(run);
        const work = await claimFor(run);
        await lab({ action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running", schedulerJobId: "6161" });
        if (cancelRequested) assert.equal((await cancel(run.runId)).status, "cancel_requested");
        return work;
      };
      const setRun = (runId, { heartbeatAt, leaseExpiresAt, cancelRequestedAt }) => db.prepare(`UPDATE runs SET heartbeat_at = ?, lease_expires_at = ?,
        cancel_requested_at = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE ? END, started_at = ? WHERE id = ?`)
        .bind(heartbeatAt, leaseExpiresAt, cancelRequestedAt ?? heartbeatAt ?? isoAgo(STALE_AGO_MS), isoAgo(STALE_AGO_MS + 60_000), runId).run();

      // Claim everything first: a lapsed lease would otherwise be handed back
      // to the runner as reconcile work by the next claim.
      const staleCancel = await inFlight({ cancelRequested: true });
      const activeLease = await inFlight({ cancelRequested: true });
      const freshCancel = await inFlight({ cancelRequested: true });
      const staleRunning = await inFlight({ cancelRequested: false });
      const neverBeat = await inFlight({ cancelRequested: true });
      // Stale cancel request, lease long expired → canceled.
      await setRun(staleCancel.runId, { heartbeatAt: isoAgo(STALE_AGO_MS), leaseExpiresAt: isoAgo(STALE_AGO_MS - 120_000) });
      // Stale heartbeat but the lease is still active → untouched.
      await setRun(activeLease.runId, { heartbeatAt: isoAgo(STALE_AGO_MS), leaseExpiresAt: isoAhead(ACTIVE_LEASE_AHEAD_MS), cancelRequestedAt: isoAgo(STALE_AGO_MS) });
      // Fresh heartbeat, lease just lapsed → within threshold, untouched.
      await setRun(freshCancel.runId, { heartbeatAt: isoAgo(FRESH_AGO_MS), leaseExpiresAt: isoAgo(FRESH_AGO_MS / 2), cancelRequestedAt: isoAgo(FRESH_AGO_MS) });
      // Running (no cancel request) with a long-dead runner → never canceled.
      await setRun(staleRunning.runId, { heartbeatAt: isoAgo(STALE_AGO_MS), leaseExpiresAt: isoAgo(STALE_AGO_MS - 120_000) });
      // Cancel request on a run whose runner never sent a heartbeat (lost right after claim).
      await setRun(neverBeat.runId, { heartbeatAt: null, leaseExpiresAt: isoAgo(STALE_AGO_MS - 120_000), cancelRequestedAt: isoAgo(STALE_AGO_MS) });

      let seq = 0;
      const seedAttempt = async ({ status, leaseExpiresAt = null, heartbeatAt = null }) => {
        const id = `att_b6mnt_${String(++seq).padStart(4, "0")}`;
        await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
          base_commit_sha, context_snapshot_sha256, status, worker_id, lease_epoch, lease_expires_at, heartbeat_at, idempotency_key, requested_by_user_id,
          created_at, started_at)
          VALUES (?, 'task_mnt', 1, 'b6-a', 'codex', 'cred_b6', 6601, ?, ?, ?, ?, ?, ?, ?, ?, 6101, ?, ?)`)
          .bind(id, "0".repeat(40), "d".repeat(64), status, status === "queued" ? null : "rnr_b6agent", status === "queued" ? 0 : 1,
            leaseExpiresAt, heartbeatAt, `seed-${id}`, isoAgo(STALE_AGO_MS + 120_000), status === "queued" ? null : isoAgo(STALE_AGO_MS + 60_000)).run();
        return id;
      };
      fixtures = {
        staleCancel: staleCancel.runId, activeLease: activeLease.runId, freshCancel: freshCancel.runId,
        staleRunning: staleRunning.runId, neverBeat: neverBeat.runId,
        staleRunningWork: staleRunning, staleCancelWork: staleCancel,
        expiredAttempt: await seedAttempt({ status: "running", leaseExpiresAt: isoAgo(STALE_AGO_MS), heartbeatAt: isoAgo(STALE_AGO_MS + 60_000) }),
        activeAttempt: await seedAttempt({ status: "running", leaseExpiresAt: isoAhead(ACTIVE_LEASE_AHEAD_MS), heartbeatAt: isoAgo(FRESH_AGO_MS / 4) }),
        queuedAttempt: await seedAttempt({ status: "queued" }),
      };
    });

    let afterRun;
    await t.test("dry run reports candidates and changes nothing", async () => {
      const before = await snapshotAll();
      const response = await maintenance({ action: "dry_run" });
      const report = await expectJson(response);
      const text = JSON.stringify(report);
      for (const id of [fixtures.staleCancel, fixtures.expiredAttempt]) {
        assert.ok(text.includes(id), `dry-run report names ${id}`);
      }
      assert.deepEqual(await snapshotAll(), before, "runs, attempts and their audit tables are untouched");
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    });

    await t.test("run finalizes stale cancel requests and expired agent leases with system audit rows only", async () => {
      const before = await snapshotAll();
      const report = await expectJson(await maintenance({ action: "run" }));
      const text = JSON.stringify(report);
      for (const id of [fixtures.staleCancel, fixtures.expiredAttempt]) assert.ok(text.includes(id), `report names ${id}`);
      afterRun = await snapshotAll();

      // Stale cancel request → canceled, with a system audit event.
      const canceled = rowOf(afterRun.runs, fixtures.staleCancel);
      assert.equal(canceled.status, "canceled");
      assert.ok(canceled.ended_at, "ended_at recorded");
      const newEvents = eventsOf(afterRun.run_events, "run_id", fixtures.staleCancel).slice(eventsOf(before.run_events, "run_id", fixtures.staleCancel).length);
      assert.ok(newEvents.length >= 1, "an audit event was written");
      assert.ok(newEvents.every((event) => event.actor_type === "system"), "maintenance events are system events");
      assert.ok(newEvents.some((event) => event.from_status === "cancel_requested" && event.to_status === "canceled"));
      const sequences = eventsOf(afterRun.run_events, "run_id", fixtures.staleCancel).map((event) => event.sequence);
      assert.deepEqual(sequences, sequences.map((_, index) => index + 1), "event sequence stays gap-free");

      // Active lease and fresh heartbeat: byte-for-byte untouched, no audit.
      for (const id of [fixtures.activeLease, fixtures.freshCancel]) {
        assert.deepEqual(rowOf(afterRun.runs, id), rowOf(before.runs, id), `${id} untouched`);
        assert.deepEqual(eventsOf(afterRun.run_events, "run_id", id), eventsOf(before.run_events, "run_id", id), `${id} no audit`);
      }
      // A running run is never canceled by maintenance (it is reconciled through the runner).
      assert.notEqual(rowOf(afterRun.runs, fixtures.staleRunning).status, "canceled");
      assert.ok(["running", "reconciling"].includes(rowOf(afterRun.runs, fixtures.staleRunning).status));

      // Expired agent lease → failed LEASE_EXPIRED, with a platform audit event.
      const failed = rowOf(afterRun.agent_attempts, fixtures.expiredAttempt);
      assert.equal(failed.status, "failed");
      assert.equal(failed.error_code, "LEASE_EXPIRED");
      assert.ok(failed.ended_at, "ended_at recorded");
      const attemptAudit = eventsOf(afterRun.agent_attempt_events, "attempt_id", fixtures.expiredAttempt)
        .filter((row) => !eventsOf(before.agent_attempt_events, "attempt_id", fixtures.expiredAttempt).some((old) => old.id === row.id));
      assert.ok(attemptAudit.length >= 1, "an attempt audit event was written");
      assert.ok(attemptAudit.every((row) => row.sequence < 0), "platform audit rows use negative sequences, never worker sequences");
      assert.match(attemptAudit.map((row) => row.payload_json).join("\n"), /LEASE_EXPIRED|failed/);

      for (const id of [fixtures.activeAttempt, fixtures.queuedAttempt]) {
        assert.deepEqual(rowOf(afterRun.agent_attempts, id), rowOf(before.agent_attempts, id), `${id} untouched`);
        assert.deepEqual(eventsOf(afterRun.agent_attempt_events, "attempt_id", id), [], `${id} no audit`);
      }
      // Nothing else in the database moved (earlier tasks' runs and attempts).
      const targetedRuns = new Set([fixtures.staleCancel, fixtures.neverBeat, fixtures.staleRunning]);
      for (const row of before.runs.filter((item) => !targetedRuns.has(item.id))) {
        assert.deepEqual(rowOf(afterRun.runs, row.id), row, `run ${row.id} untouched`);
      }
      for (const row of before.agent_attempts.filter((item) => item.id !== fixtures.expiredAttempt)) {
        assert.deepEqual(rowOf(afterRun.agent_attempts, row.id), row, `attempt ${row.id} untouched`);
      }
    });

    await t.test("a second run is idempotent and a finalized run stays dead for its runner", async () => {
      await expectJson(await maintenance({ action: "run" }));
      assert.deepEqual(await snapshotAll(), afterRun, "second run changes nothing and writes no audit rows");
      const dry = await expectJson(await maintenance({ action: "dry_run" }));
      assert.ok(!JSON.stringify(dry).includes(fixtures.staleCancel), "already finalized runs are no longer candidates");
      const late = await lab({ action: "heartbeat", runId: fixtures.staleCancel, leaseEpoch: fixtures.staleCancelWork.leaseEpoch, phase: "running" }, 409);
      assert.equal(late.code, "LEASE_LOST");
      const { work } = await lab({ action: "claim" });
      assert.notEqual(work?.runId, fixtures.staleCancel, "a canceled run is never handed out again");
    });

    await t.test("a cancel request whose runner never sent a heartbeat is finalized once its age passes the threshold", async () => {
      // Ambiguity: heartbeat_at is NULL, so the age must fall back to the cancel
      // request (or start) time. Kept separate so the main rules above stand alone.
      const row = rowOf(afterRun.runs, fixtures.neverBeat);
      assert.equal(row.status, "canceled");
      const events = eventsOf(afterRun.run_events, "run_id", fixtures.neverBeat);
      assert.equal(events.at(-1).actor_type, "system");
      assert.equal(events.at(-1).to_status, "canceled");
    });

    await t.test("nothing left the sandbox and foreign keys hold", async () => {
      assert.equal(outbound, 0, "no external requests");
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
  } finally {
    await mf.dispose();
  }
});
