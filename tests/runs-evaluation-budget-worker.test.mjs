import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Batch 6 (pack 02 §9, T22): formal evaluation budget and reproduction checks
// against the built Worker. Synthetic fixtures only; outbound network is
// blocked and the lab runner is simulated by direct protocol calls.
const EVAL = "e".repeat(64);
const EVAL2 = "9".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `registry.lab/train@${IMAGE_DIGEST}`;
const SHA_A = "1".repeat(40);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const TASKS = {
  task_lim: { maxFormalEvaluations: 3 },
  task_race: { maxFormalEvaluations: 2 },
  task_free: {},
  task_rep: { reproTolerance: 0.05 },
  task_def: {},
};

test("research validity: evaluation budget and reproduction checks", { timeout: 240_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "runs-budget-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => new Response("No external services in this test", { status: 502 }),
  });
  const origin = "http://localhost";
  const personas = { studentA: "student", studentB: "student" };
  const cookie = (actor) => `tanyan_session=budget-${actor}; tanyan_persona=${personas[actor] ?? "management"}`;
  const call = (path, { actor, method = "GET", body } = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { cookie: cookie(actor), ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const expectJson = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    return JSON.parse(text);
  };
  const admin = (body) => call("/api/admin/lab", { actor: "root", method: "POST", body }).then((r) => expectJson(r));
  const runs = (body, actor = "studentA", status = 200) => call("/api/runs", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const detail = (runId, actor = "studentA") => call(`/api/runs?runId=${runId}`, { actor }).then((r) => expectJson(r));
  const budgetView = (taskId, protocol, actor = "studentA", status = 200) =>
    call(`/api/runs?view=evaluation_budget&taskId=${taskId}&evaluationProtocolSha256=${protocol}`, { actor }).then((r) => expectJson(r, status));
  let keyCounter = 0;
  const key = (label = "k") => `${label}-${String(++keyCounter).padStart(6, "0")}`;

  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('bg-a', '评测测试甲', '博士', 2025, '实验', 1), ('bg-b', '评测测试乙', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (2101, 'bg-student-a', '评测测试甲', 'student', 'bg-a'), (2102, 'bg-student-b', '评测测试乙', 'student', 'bg-b'),
      (2103, 'bg-mentor-1', '审核导师', 'mentor', NULL), (2106, 'bg-root', '超级管理员', 'superadmin', NULL)`).run();
    await db.prepare("INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES (2103, 'bg-a', 1, 1)").run();
    for (const [id, actor] of [[2101, "studentA"], [2102, "studentB"], [2103, "mentor1"], [2106, "root"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`budget-${actor}`), id).run();
    }
    await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (88, 'synthetic-lab', 'Organization')").run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch)
      VALUES ('bg-a', 6001, 88, 'synthetic-lab/bg-research', 'main')`).run();
    await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_agentbg', '代理', 'agent', ?)").bind("f".repeat(64)).run();
    await db.prepare("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_bg', 2101, 'codex', 'rnr_agentbg')").run();
    for (const [taskId, budget] of Object.entries(TASKS)) {
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
        VALUES (?, 'bg-a', '合成任务', 'confirmed', 1, 1, 2101, ?, ?)`).bind(taskId, `seed-${taskId}`, `seed-${taskId}`).run();
      await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
        budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
        VALUES (?, 1, '合成任务', '合成问题', '合成说明', '合成标准', ?, ?, 2101, 2101, CURRENT_TIMESTAMP)`)
        .bind(taskId, JSON.stringify({ maxGpuCount: 2, maxWalltimeMinutes: 600, ...budget }), "d".repeat(64)).run();
      await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
        base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
        VALUES (?, ?, 1, 'bg-a', 'codex', 'cred_bg', 6001, ?, ?, 'change_ready', ?, 2101)`)
        .bind(`att_${taskId}`, taskId, "0".repeat(40), "d".repeat(64), `seed-attempt-${taskId}`).run();
      await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, status)
        VALUES (?, ?, ?, 'bg-a', 6001, ?, ?, ?, 'open')`)
        .bind(`cr_${taskId}`, taskId, `att_${taskId}`, "0".repeat(40), `tanyan/${taskId}/seed`, SHA_A).run();
    }

    const registeredRunner = await admin({ action: "register_runner", label: "GPU 服务器", kind: "compute" });
    const runner = registeredRunner.runner.id;
    const runnerToken = registeredRunner.token;
    const entry = { action: "register_entrypoint", studentId: "bg-a", argv: ["python", "eval.py"], imageRef: IMAGE, paramsSchema: {} };
    const entrypoint = (await admin({ ...entry, name: "eval", evaluationProtocolSha256: EVAL })).entrypoint;
    const entrypoint2 = (await admin({ ...entry, name: "eval-v2", evaluationProtocolSha256: EVAL2 })).entrypoint;
    const policy = { schema: "tanyan.egress/v1", allowedExtensions: [".json"], maxFileBytes: 10_000, maxTotalBytes: 50_000, allowImages: false, blockDatasetHashMatches: true };
    const dataset = (await admin({ action: "register_dataset", label: "合成数据", runnerId: runner, manifestSha256: "a".repeat(64), splitManifestSha256: "b".repeat(64), egressPolicy: policy })).dataset;
    await admin({ action: "grant_dataset", datasetVersionId: dataset.id, studentId: "bg-a" });

    const lab = (body, status = 200) => mf.dispatchFetch(origin + "/api/lab/runs", {
      method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => expectJson(r, status));
    const create = (taskId, overrides = {}, status = 200) => runs({
      action: "create", taskId, changeRequestId: `cr_${taskId}`, entrypointId: entrypoint.id, params: {}, datasetVersionId: dataset.id,
      resources: { gpuCount: 1, walltimeMinutes: 60, memoryGb: 16 }, idempotencyKey: key("create"), ...overrides,
    }, "studentA", status);
    const rerun = (run, status = 200) => runs({ action: "rerun", runId: run.runId, idempotencyKey: key("rerun") }, "studentA", status);
    const approve = (run) => runs({ action: "approve", runId: run.runId, runSpecSha256: run.runSpecSha256 }, "mentor1");
    const dispatch = async (run) => {
      await approve(run);
      const { work } = await lab({ action: "claim" });
      assert.equal(work?.runId, run.runId);
      return work;
    };
    const metricsFile = (work, values) => {
      const content = JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: work.spec.evaluationProtocolSha256, split: "test", values });
      return {
        artifact: { relativePath: "metrics.json", sha256: sha256(content), sizeBytes: Buffer.byteLength(content), kind: "metrics", egressDecision: "published", egressReason: "runner", labLocator: "lab://out/metrics.json" },
        published: { relativePath: "metrics.json", contentBase64: Buffer.from(content).toString("base64") },
      };
    };
    /** Completes a dispatched run; values === null means no metrics file at all. */
    const finish = async (work, values) => {
      const items = values ? [metricsFile(work, values)] : [];
      const manifest = {
        schema: "tanyan.manifest/v1", runId: work.runId, attempt: work.attempt, runSpecSha256: work.runSpecSha256, approvalId: work.approvalId,
        repository: { repositoryId: work.spec.repository.repositoryId, executedCommitSha: work.spec.executedCommitSha },
        inputs: { datasetVersionId: work.spec.dataset.versionId, manifestSha256: work.spec.dataset.manifestSha256,
          splitManifestSha256: work.spec.dataset.splitManifestSha256, evaluationProtocolSha256: work.spec.evaluationProtocolSha256, seeds: [7] },
        environment: { imageDigest: IMAGE_DIGEST, driverVersion: "550.00", gpuModel: "synthetic" },
        execution: { runnerId: runner, schedulerJobId: "4242", submitTag: work.submitTag, entrypointId: work.spec.entrypoint.id,
          startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T01:00:00Z", exitCode: 0 },
        metricsArtifactPath: values ? "metrics.json" : null, artifacts: items.map((item) => item.artifact),
      };
      const done = await lab({ action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "completed", exitCode: 0,
        manifest, publishedFiles: items.map((item) => item.published) });
      assert.equal(done.status, "completed");
    };
    const fail = (work) => lab({ action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "failed", exitCode: 1, manifest: null });
    const completedRun = async (run, values) => { await finish(await dispatch(run), values); return run; };
    const runCount = async (taskId) => (await db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").bind(taskId).first()).n;

    await t.test("budget: pre-dispatch cancels are free, failures and reruns count, the limit is enforced per protocol", async () => {
      assert.deepEqual((await budgetView("task_lim", EVAL)).evaluationBudget,
        { taskVersion: 1, evaluationProtocolSha256: EVAL, used: 0, limit: 3, remaining: 3 });
      await budgetView("task_lim", EVAL, "studentB", 403);
      await budgetView("task_lim", "nope", "studentA", 400);

      // Canceled while awaiting approval, and canceled while queued: not counted.
      const awaiting = await create("task_lim");
      assert.equal((await budgetView("task_lim", EVAL)).evaluationBudget.used, 1);
      await runs({ action: "cancel", runId: awaiting.runId });
      const queued = await create("task_lim", { resources: { gpuCount: 0, walltimeMinutes: 60, memoryGb: 16 } });
      await approve(queued);
      await runs({ action: "cancel", runId: queued.runId });
      assert.equal((await budgetView("task_lim", EVAL)).evaluationBudget.used, 0, "canceled before dispatch is not a formal evaluation");

      // A failed run counts; a completed run counts; its rerun counts.
      await fail(await dispatch(await create("task_lim")));
      const completed = await completedRun(await create("task_lim", { resources: { gpuCount: 2, walltimeMinutes: 60, memoryGb: 16 } }), { accuracy: 0.9 });
      const again = await rerun(completed);
      assert.equal(again.attempt, 2);
      const againDetail = await detail(again.runId);
      assert.deepEqual(againDetail.evaluationBudget, { taskVersion: 1, evaluationProtocolSha256: EVAL, used: 3, limit: 3, remaining: 0 });
      assert.equal(againDetail.reproduction, null, "not completed yet");

      const before = await runCount("task_lim");
      const rejected = await create("task_lim", {}, 409);
      assert.equal(rejected.code, "EVALUATION_BUDGET_EXHAUSTED");
      assert.match(rejected.error, /正式评测次数已用完/u);
      assert.match(rejected.error, /第 1 版/u);
      assert.equal((await rerun(completed, 409)).code, "EVALUATION_BUDGET_EXHAUSTED", "a rerun is a formal evaluation too");
      assert.equal(await runCount("task_lim"), before, "rejected attempts leave no run rows");
      const orphanEvents = await db.prepare("SELECT COUNT(*) AS n FROM run_events e WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = e.run_id)").first();
      assert.equal(orphanEvents.n, 0, "no events for rejected runs");

      // Idempotent replay of an accepted create still answers, even at the limit.
      const replayKey = key("replay");
      await runs({ action: "cancel", runId: again.runId });
      const replayed = await create("task_lim", { idempotencyKey: replayKey, resources: { gpuCount: 1, walltimeMinutes: 61, memoryGb: 16 } });
      assert.equal((await create("task_lim", { idempotencyKey: replayKey, resources: { gpuCount: 1, walltimeMinutes: 61, memoryGb: 16 } })).runId, replayed.runId);

      // A different evaluation protocol is counted separately.
      const other = await create("task_lim", { entrypointId: entrypoint2.id });
      assert.deepEqual((await budgetView("task_lim", EVAL2)).evaluationBudget,
        { taskVersion: 1, evaluationProtocolSha256: EVAL2, used: 1, limit: 3, remaining: 2 });
      assert.equal((await detail(other.runId)).evaluationBudget.evaluationProtocolSha256, EVAL2);
      assert.equal((await budgetView("task_lim", EVAL)).evaluationBudget.remaining, 0);

      // Canceled after dispatch is counted (the lab already spent the evaluation).
      const inFlight = await dispatch(other);
      await runs({ action: "cancel", runId: other.runId });
      assert.equal((await lab({ action: "complete", runId: inFlight.runId, leaseEpoch: inFlight.leaseEpoch, outcome: "canceled", exitCode: null, manifest: null })).status, "canceled");
      assert.equal((await budgetView("task_lim", EVAL2)).evaluationBudget.used, 1);
    });

    await t.test("budget: concurrent creates never exceed the limit", async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => call("/api/runs", {
        actor: "studentA", method: "POST", body: {
          action: "create", taskId: "task_race", changeRequestId: "cr_task_race", entrypointId: entrypoint.id, params: {},
          datasetVersionId: dataset.id, resources: { gpuCount: index % 2, walltimeMinutes: 60, memoryGb: 16 }, idempotencyKey: key("race"),
        },
      }).then(async (response) => ({ status: response.status, body: JSON.parse(await response.text()) }))));
      assert.equal(responses.filter((item) => item.status === 200).length, 2, JSON.stringify(responses.map((item) => item.status)));
      const rejected = responses.filter((item) => item.status !== 200);
      assert.equal(rejected.length, 6);
      assert.ok(rejected.every((item) => item.status === 409 && item.body.code === "EVALUATION_BUDGET_EXHAUSTED"), JSON.stringify(rejected));
      assert.equal(await runCount("task_race"), 2);
      assert.equal((await budgetView("task_race", EVAL)).evaluationBudget.remaining, 0);
    });

    await t.test("budget: no limit means unlimited", async () => {
      let last;
      for (let index = 0; index < 5; index += 1) last = await create("task_free", { resources: { gpuCount: index % 3, walltimeMinutes: 60, memoryGb: 16 } });
      assert.deepEqual((await budgetView("task_free", EVAL)).evaluationBudget,
        { taskVersion: 1, evaluationProtocolSha256: EVAL, used: 5, limit: null, remaining: null });
      const view = await detail(last.runId);
      assert.equal(view.evaluationBudget.limit, null);
      assert.equal(view.evaluationBudget.remaining, null);
    });

    await t.test("reproduction: compares with the latest earlier completed execution within the task tolerance", async () => {
      const first = await completedRun(await create("task_rep"), { accuracy: 0.91, loss: 0.3 });
      assert.equal((await detail(first.runId)).reproduction, null, "attempt 1 has nothing to compare with");

      const second = await completedRun(await rerun(first), { accuracy: 0.93, loss: 0.4 });
      const secondView = (await detail(second.runId)).reproduction;
      assert.equal(secondView.comparedRunId, first.runId);
      assert.equal(secondView.comparedAttempt, 1);
      assert.equal(secondView.tolerance, 0.05);
      assert.deepEqual(secondView.metrics.map((item) => [item.name, item.current, item.previous, item.withinTolerance]),
        [["accuracy", 0.93, 0.91, true], ["loss", 0.4, 0.3, false]]);
      assert.ok(Math.abs(secondView.metrics[0].diff - 0.02) < 1e-9);
      assert.ok(Math.abs(secondView.metrics[1].diff - 0.1) < 1e-9);
      assert.equal(secondView.reproduced, false, "one metric beyond tolerance");

      // A failed execution in between is skipped; it has no reproduction itself.
      const third = await rerun(first);
      await fail(await dispatch(third));
      assert.equal((await detail(third.runId)).reproduction, null);

      // Metrics missing on one side are not compared.
      const fourth = await completedRun(await rerun(first), { accuracy: 0.92, f1: 0.5 });
      const fourthView = (await detail(fourth.runId)).reproduction;
      assert.equal(fourthView.comparedRunId, second.runId, "latest earlier completed execution");
      assert.equal(fourthView.comparedAttempt, 2);
      assert.deepEqual(fourthView.metrics.map((item) => [item.name, item.withinTolerance]), [["accuracy", true]]);
      assert.equal(fourthView.reproduced, true);

      // No metrics file at all: nothing to compare, never reported as reproduced.
      const fifth = await completedRun(await rerun(first), null);
      const fifthView = (await detail(fifth.runId)).reproduction;
      assert.equal(fifthView.comparedAttempt, 4);
      assert.deepEqual(fifthView.metrics, []);
      assert.equal(fifthView.reproduced, false);
      const sixth = await completedRun(await rerun(first), { accuracy: 0.92 });
      const sixthView = (await detail(sixth.runId)).reproduction;
      assert.equal(sixthView.comparedAttempt, 5, "previous completed execution without metrics");
      assert.deepEqual(sixthView.metrics, []);
      assert.equal(sixthView.reproduced, false);
      assert.equal((await detail(sixth.runId, "mentor1")).reproduction.comparedRunId, fifth.runId, "reviewers see the same view");
    });

    await t.test("reproduction: default tolerance is 0.01 absolute", async () => {
      const first = await completedRun(await create("task_def"), { accuracy: 0.9, loss: 0.5 });
      const second = await completedRun(await rerun(first), { accuracy: 0.905, loss: 0.52 });
      const view = (await detail(second.runId)).reproduction;
      assert.equal(view.tolerance, 0.01);
      assert.deepEqual(view.metrics.map((item) => [item.name, item.withinTolerance]), [["accuracy", true], ["loss", false]]);
      assert.equal(view.reproduced, false);
      // Exactly at the tolerance (0.915 − 0.905, with floating-point noise) is within.
      const third = await completedRun(await rerun(first), { accuracy: 0.915 });
      const edge = (await detail(third.runId)).reproduction;
      assert.deepEqual(edge.metrics.map((item) => [item.name, item.withinTolerance]), [["accuracy", true]]);
      assert.equal(edge.reproduced, true);
    });
  } finally {
    await mf.dispose();
  }
});
