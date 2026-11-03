import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Independent adversarial suite for batch 4 (frontend plan FA2–FA4), written
// only from the header/types of lib/research-loop/results-contract.ts, the
// plan, design-pack T19–T21 and the authorization model (spec §5). It does not
// read the implementing services. Runs are produced through the real run
// registry + simulated lab-runner protocol, never by inserting run rows.
//
// Principles under test:
// - technical validity ≠ hypothesis ≠ acceptance: a draft never claims an
//   acceptance that has not happened, and a baseline is only a comparison
//   object (it never touches the RunSpec, its hash, approvals or run status);
// - protocol changes are visible (T21): protocolMatches is false, not hidden;
// - authorization: students only their own records; mentors only assigned
//   students, decisions need can_review=1; superadmin everything (except
//   writing a student's own interpretation).
const EVAL = "e".repeat(64);
const EVAL2 = "4".repeat(64);
const DATA_MANIFEST = "a".repeat(64);
const SPLIT_MANIFEST = "b".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `registry.lab/train@${IMAGE_DIGEST}`;
const SHA_A = "1".repeat(40);
const SHA_A2 = "3".repeat(40);
const SHA_A3 = "5".repeat(40);
const SHA_B = "2".repeat(40);
const PR_URL = "https://github.com/synthetic-lab/a-research/pull/12";
const HEX64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i;
const HEX40_PLUS = /(?<![0-9a-f])[0-9a-f]{40,}(?![0-9a-f])/i;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test("batch 4 rules: baseline, interpretation, progress draft and evidence report", { timeout: 300_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "results-rules-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const personas = { studentA: "student", studentB: "student" };
  const cookie = (actor) => actor ? `tanyan_session=rr-${actor}; tanyan_persona=${personas[actor] ?? "management"}` : "";
  const call = (path, { actor, method = "GET", body } = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { cookie: cookie(actor), ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const readJson = async (response, expected) => {
    const text = await response.text();
    const allowed = Array.isArray(expected) ? expected : [expected];
    assert.ok(allowed.includes(response.status), `expected ${allowed.join("/")}, got ${response.status}: ${text}`);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    return text ? JSON.parse(text) : null;
  };
  const admin = (body) => call("/api/admin/lab", { actor: "root", method: "POST", body }).then((r) => readJson(r, 200));
  const runs = (body, actor = "studentA", status = 200) => call("/api/runs", { actor, method: "POST", body }).then((r) => readJson(r, status));
  const results = (body, actor = "studentA", status = 200) => call("/api/run-results", { actor, method: "POST", body }).then((r) => readJson(r, status));
  const detail = (runId, actor = "studentA", status = 200) => call(`/api/runs?runId=${runId}`, { actor }).then((r) => readJson(r, status));
  const evidence = (query, actor = "studentA", status = 200) => call(`/api/research-loop/evidence?${new URLSearchParams(query)}`, { actor }).then((r) => readJson(r, status));
  const lab = (token, body, status = 200) => mf.dispatchFetch(origin + "/api/lab/runs", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => readJson(r, status));
  let counter = 0;
  const key = (label = "k") => `${label}-${String(++counter).padStart(6, "0")}`;
  const REJECTED = [400, 403, 404, 409];
  const INVALID = [400, 404, 409, 422];

  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('rr-a', '规则测试甲', '博士', 2025, '实验', 1), ('rr-b', '规则测试乙', '硕士', 2025, '实验', 1)`).run();
    // mentor1 reviews A; mentor3 only views A; mentor4 reviews B only; mentor5 has no assignment.
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (2101, 'rr-student-a', '规则测试甲', 'student', 'rr-a'), (2102, 'rr-student-b', '规则测试乙', 'student', 'rr-b'),
      (2103, 'rr-mentor-1', '审核导师一', 'mentor', NULL), (2105, 'rr-mentor-3', '只读导师', 'mentor', NULL),
      (2108, 'rr-mentor-4', '乙的导师', 'mentor', NULL), (2109, 'rr-mentor-5', '未分配导师', 'mentor', NULL),
      (2106, 'rr-root', '超级管理员', 'superadmin', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (2103, 'rr-a', 1, 1), (2105, 'rr-a', 0, 1), (2108, 'rr-b', 1, 1)`).run();
    const actors = [[2101, "studentA"], [2102, "studentB"], [2103, "mentor1"], [2105, "mentor3"], [2108, "mentor4"], [2109, "mentor5"], [2106, "root"]];
    for (const [id, actor] of actors) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`rr-${actor}`), id).run();
    }
    await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (88, 'synthetic-lab', 'Organization')").run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch) VALUES
      ('rr-a', 6001, 88, 'synthetic-lab/a-research', 'main'), ('rr-b', 6002, 88, 'synthetic-lab/b-research', 'main')`).run();
    const tasks = [["task_rra", "rr-a", 2101, 6001], ["task_rra2", "rr-a", 2101, 6001], ["task_rra3", "rr-a", 2101, 6001], ["task_rrb", "rr-b", 2102, 6002]];
    for (const [taskId, studentId, userId] of tasks) {
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
        VALUES (?, ?, ?, 'confirmed', 1, 1, ?, ?, ?)`).bind(taskId, studentId, `合成任务 ${taskId}`, userId, `seed-${taskId}`, `seed-${taskId}`).run();
      await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
        budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
        VALUES (?, 1, ?, '保密研究问题甲', '保密操作说明乙', '合成标准', '{"maxGpuCount":2,"maxWalltimeMinutes":600}', ?, ?, ?, CURRENT_TIMESTAMP)`)
        .bind(taskId, `合成任务 ${taskId}`, "d".repeat(64), userId, userId).run();
    }
    await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_agentrr', '代理', 'agent', ?)").bind("f".repeat(64)).run();
    await db.prepare("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_rra', 2101, 'codex', 'rnr_agentrr'), ('cred_rrb', 2102, 'codex', 'rnr_agentrr')").run();
    // cr_a carries a PR; cr_a2 has none (no PR number, empty URL); cr_a3 for the evidence scenario; cr_b for student B.
    const changes = [
      ["cr_a", "task_rra", "rr-a", 6001, "cred_rra", 2101, SHA_A, 12, PR_URL],
      ["cr_a2", "task_rra2", "rr-a", 6001, "cred_rra", 2101, SHA_A2, null, ""],
      ["cr_a3", "task_rra3", "rr-a", 6001, "cred_rra", 2101, SHA_A3, 13, "https://github.com/synthetic-lab/a-research/pull/13"],
      ["cr_b", "task_rrb", "rr-b", 6002, "cred_rrb", 2102, SHA_B, 3, "https://github.com/synthetic-lab/b-research/pull/3"],
    ];
    for (const [id, taskId, studentId, repo, cred, userId, head, prNumber, prUrl] of changes) {
      await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
        base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
        VALUES (?, ?, 1, ?, 'codex', ?, ?, ?, ?, 'change_ready', ?, ?)`)
        .bind(`att_${id}`, taskId, studentId, cred, repo, "0".repeat(40), "d".repeat(64), `seed-att-${id}`, userId).run();
      await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, pr_number, pr_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
        .bind(id, taskId, `att_${id}`, studentId, repo, "0".repeat(40), `tanyan/${id}/seed`, head, prNumber, prUrl).run();
    }

    // ---- lab fixture through the admin API ----
    const createdRunner = await admin({ action: "register_runner", label: "GPU 服务器", kind: "compute" });
    const runner = createdRunner.runner.id;
    const runnerToken = createdRunner.token;
    const paramsSchema = { lr: { type: "number", required: true, minimum: 0, maximum: 1 } };
    const entry = (studentId, protocol) => admin({ action: "register_entrypoint", studentId, name: `train-${studentId}-${protocol[0]}`,
      argv: ["python", "train.py"], imageRef: IMAGE, evaluationProtocolSha256: protocol, paramsSchema }).then((r) => r.entrypoint);
    const epA = await entry("rr-a", EVAL);
    const epA2 = await entry("rr-a", EVAL2);
    const epB = await entry("rr-b", EVAL);
    const policy = { schema: "tanyan.egress/v1", allowedExtensions: [".json", ".txt", ".csv"], maxFileBytes: 4000, maxTotalBytes: 20000, allowImages: false, blockDatasetHashMatches: true };
    const dataset = (await admin({ action: "register_dataset", label: "合成数据", runnerId: runner, manifestSha256: DATA_MANIFEST, splitManifestSha256: SPLIT_MANIFEST, egressPolicy: policy })).dataset;
    await admin({ action: "grant_dataset", datasetVersionId: dataset.id, studentId: "rr-a" });
    await admin({ action: "grant_dataset", datasetVersionId: dataset.id, studentId: "rr-b" });

    // ---- run helpers (registry + simulated runner) ----
    let lrStep = 0;
    const createRun = ({ student = "A", taskId, changeRequestId, entrypoint } = {}) => {
      const isB = student === "B";
      return runs({
        action: "create", taskId: taskId ?? (isB ? "task_rrb" : "task_rra"), changeRequestId: changeRequestId ?? (isB ? "cr_b" : "cr_a"),
        entrypointId: (entrypoint ?? (isB ? epB : epA)).id, params: { lr: (++lrStep) / 1000 }, datasetVersionId: dataset.id,
        resources: { gpuCount: 1, walltimeMinutes: 60, memoryGb: 16 }, idempotencyKey: key("create"),
      }, isB ? "studentB" : "studentA");
    };
    const claimedRun = async (options = {}) => {
      const run = await createRun(options);
      await runs({ action: "approve", runId: run.runId, runSpecSha256: run.runSpecSha256 }, options.student === "B" ? "mentor4" : "mentor1");
      const { work } = await lab(runnerToken, { action: "claim" });
      assert.equal(work?.runId, run.runId);
      return work;
    };
    const metricsJson = (protocol, accuracy) => JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: protocol, split: "test", values: { accuracy } });
    const file = (relativePath, content, kind = "other") => ({
      artifact: { relativePath, sha256: sha256(content), sizeBytes: Buffer.byteLength(content), kind, egressDecision: "published", egressReason: "runner", labLocator: `lab://out/${relativePath}` },
      published: { relativePath, contentBase64: Buffer.from(content).toString("base64") },
    });
    const finish = (work, items, { metricsArtifactPath = "metrics.json" } = {}) => lab(runnerToken, {
      action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "completed", exitCode: 0,
      manifest: {
        schema: "tanyan.manifest/v1", runId: work.runId, attempt: work.attempt, runSpecSha256: work.runSpecSha256, approvalId: work.approvalId,
        repository: { repositoryId: work.spec.repository.repositoryId, executedCommitSha: work.spec.executedCommitSha },
        inputs: { datasetVersionId: work.spec.dataset.versionId, manifestSha256: work.spec.dataset.manifestSha256,
          splitManifestSha256: work.spec.dataset.splitManifestSha256, evaluationProtocolSha256: work.spec.evaluationProtocolSha256, seeds: [7] },
        environment: { imageDigest: IMAGE_DIGEST, driverVersion: "550.00", gpuModel: "synthetic" },
        execution: { runnerId: runner, schedulerJobId: "4242", submitTag: work.submitTag, entrypointId: work.spec.entrypoint.id,
          startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T01:00:00Z", exitCode: 0 },
        metricsArtifactPath, artifacts: items.map((item) => item.artifact),
      },
      publishedFiles: items.map((item) => item.published),
    });
    // Completed + technically valid; `protocol` is the metrics file's claim (defaults to the spec's).
    const validRun = async (options = {}, accuracy = 0.9) => {
      const work = await claimedRun(options);
      const protocol = work.spec.evaluationProtocolSha256;
      const done = await finish(work, [file("metrics.json", metricsJson(protocol, accuracy), "metrics")]);
      assert.equal(done.status, "completed");
      assert.equal(done.technicalValidity, "valid");
      return work.runId;
    };
    const failedRun = async (options = {}, failureReason = "OOM") => {
      const work = await claimedRun(options);
      await lab(runnerToken, { action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "failed", exitCode: 137, failureReason, manifest: null });
      return work.runId;
    };
    const tableCounts = async () => {
      const { results: tables } = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`).all();
      const counts = {};
      for (const { name } of tables) counts[name] = (await db.prepare(`SELECT count(*) AS n FROM "${name}"`).first()).n;
      return counts;
    };
    const runState = async (runId) => ({
      run: await db.prepare("SELECT run_spec_sha256, attempt, approval_id, status, exit_code, failure_reason, ended_at FROM runs WHERE id = ?").bind(runId).first(),
      approvals: (await db.prepare(`SELECT a.* FROM run_approvals a JOIN runs r ON r.run_spec_sha256 = a.run_spec_sha256 WHERE r.id = ? ORDER BY a.id`).bind(runId).all()).results,
      review: await db.prepare("SELECT * FROM result_reviews WHERE run_id = ?").bind(runId).first(),
      specs: (await db.prepare("SELECT count(*) AS n FROM run_specs").first()).n,
    });

    // ---- shared runs (only existing endpoints; must pass on any build) ----
    const r = {};
    await t.test("fixture: runs in every relevant state", async () => {
      r.target = await validRun({}, 0.91);
      r.sameProtocol = await validRun({}, 0.88);
      r.otherProtocol = await validRun({ entrypoint: epA2 }, 0.95);
      r.otherTask = await validRun({ taskId: "task_rra2", changeRequestId: "cr_a2" }, 0.87);
      r.failed = await failedRun();
      const driftWork = await claimedRun();
      const drift = await finish(driftWork, [file("metrics.json", metricsJson("9".repeat(64), 0.99), "metrics")]);
      assert.equal(drift.technicalValidity, "invalid", "T21: metrics under another protocol are not valid");
      r.invalid = driftWork.runId;
      const unknownWork = await claimedRun();
      const unknown = await finish(unknownWork, [file("log.txt", "trained", "log")], { metricsArtifactPath: null });
      assert.equal(unknown.status, "completed");
      assert.notEqual(unknown.technicalValidity, "valid", "T19: no metrics, not valid");
      r.unknown = unknownWork.runId;
      r.waiting = (await createRun()).runId;
      r.canceled = (await createRun()).runId;
      await runs({ action: "cancel", runId: r.canceled });
      r.foreign = await validRun({ student: "B" }, 0.97);
      r.interp = await validRun({}, 0.92);
      r.interpFailed = await failedRun({}, "CUDA error");
      r.reviewNoInterp = await validRun({}, 0.89);
      r.noPr = await validRun({ taskId: "task_rra2", changeRequestId: "cr_a2" }, 0.86);
      assert.equal((await detail(r.target)).review.state, "pending");
    });

    // ================= Baseline (FA2, T21) =================
    const setBaseline = (runId, baselineRunId, actor = "studentA", status = 200) =>
      runs({ action: "set_baseline", runId, baselineRunId }, actor, status);

    await t.test("baseline: candidates are only completed, technically valid runs of the same student, never the run itself", async () => {
      const view = await detail(r.target);
      assert.equal(view.baseline, null, "no baseline is shown as none, not invented");
      assert.ok(Array.isArray(view.baselineCandidates));
      const ids = view.baselineCandidates.map((item) => item.runId);
      for (const id of [r.sameProtocol, r.otherProtocol, r.otherTask]) assert.ok(ids.includes(id), `candidate ${id}`);
      for (const id of [r.target, r.failed, r.invalid, r.unknown, r.waiting, r.canceled, r.foreign, r.interpFailed]) {
        assert.ok(!ids.includes(id), `not a candidate: ${id}`);
      }
      const byId = Object.fromEntries(view.baselineCandidates.map((item) => [item.runId, item]));
      assert.equal(byId[r.sameProtocol].protocolMatches, true);
      assert.equal(byId[r.otherProtocol].protocolMatches, false, "a different protocol is listed but flagged");
      assert.equal(byId[r.otherTask].taskId, "task_rra2", "any task of the same student");
    });

    await t.test("baseline: invalid targets are rejected and leave nothing behind", async () => {
      // Prove the action exists, so a generic "unknown action" 400 cannot pass the rejections below.
      assert.equal((await setBaseline(r.target, null)).baseline, null);
      for (const candidate of [r.target, r.failed, r.invalid, r.unknown, r.waiting, r.canceled, r.interpFailed, "run_doesnotexist", ""]) {
        await setBaseline(r.target, candidate, "studentA", INVALID);
      }
      await setBaseline(r.target, r.foreign, "studentA", REJECTED);
      await setBaseline(r.target, r.foreign, "root", INVALID);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM run_baselines").first()).n, 0);
      assert.equal((await detail(r.target)).baseline, null);
    });

    await t.test("baseline: setting and clearing never changes the spec hash, approvals, review or run status", async () => {
      const before = await runState(r.target);
      const viewBefore = await detail(r.target);
      const set = await setBaseline(r.target, r.sameProtocol);
      assert.equal(set.runId, r.target);
      assert.equal(set.baseline.runId, r.sameProtocol);
      assert.equal(set.baseline.protocolMatches, true);
      assert.equal(set.baseline.evaluationProtocolSha256, EVAL);
      assert.equal(set.baseline.setByUserId, 2101);
      assert.deepEqual(set.baseline.metrics, { accuracy: 0.88 });
      assert.equal(set.baseline.executedCommitShort.length < 40, true, "short commit only");
      assert.ok(SHA_A.startsWith(set.baseline.executedCommitShort));
      assert.deepEqual(await runState(r.target), before);
      const viewSet = await detail(r.target);
      assert.equal(viewSet.baseline.runId, r.sameProtocol);
      assert.deepEqual(viewSet.spec, viewBefore.spec);
      assert.deepEqual(viewSet.approvals, viewBefore.approvals);
      assert.equal(viewSet.run.status, "completed");
      assert.deepEqual(viewSet.review, viewBefore.review);
      // The baseline run itself is untouched too.
      const baselineBefore = await runState(r.sameProtocol);
      const cleared = await setBaseline(r.target, null, "mentor1");
      assert.equal(cleared.baseline, null);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM run_baselines WHERE run_id = ?").bind(r.target).first()).n, 0);
      assert.deepEqual(await runState(r.target), before);
      assert.deepEqual(await runState(r.sameProtocol), baselineBefore);
      assert.equal((await detail(r.target)).baseline, null);
      // Clearing twice is harmless.
      assert.equal((await setBaseline(r.target, null)).baseline, null);
      // A not-yet-approved run may carry a baseline without touching its approval state.
      const waitingBefore = await runState(r.waiting);
      await setBaseline(r.waiting, r.sameProtocol);
      assert.deepEqual(await runState(r.waiting), waitingBefore);
      assert.equal((await detail(r.waiting)).run.status, "awaiting_approval");
      await setBaseline(r.waiting, null);
    });

    await t.test("baseline: a different evaluation protocol is accepted but protocolMatches is false (T21)", async () => {
      const set = await setBaseline(r.target, r.otherProtocol, "mentor1");
      assert.equal(set.baseline.protocolMatches, false);
      assert.equal(set.baseline.evaluationProtocolSha256, EVAL2);
      assert.equal(set.baseline.setByUserId, 2103);
      const view = await detail(r.target, "mentor1");
      assert.equal(view.baseline.protocolMatches, false, "mismatch is shown, never hidden");
      // Same protocol across tasks matches.
      const cross = await setBaseline(r.target, r.otherTask);
      assert.equal(cross.baseline.protocolMatches, true);
      assert.equal(cross.baseline.taskId, "task_rra2");
      await setBaseline(r.target, null);
    });

    await t.test("baseline: outsiders, other students, view-only and unassigned mentors are rejected", async () => {
      for (const actor of ["studentB", "mentor3", "mentor4", "mentor5"]) {
        await setBaseline(r.target, r.sameProtocol, actor, 403);
        await setBaseline(r.target, null, actor, 403);
      }
      const anonymous = await call("/api/runs", { method: "POST", body: { action: "set_baseline", runId: r.target, baselineRunId: r.sameProtocol } });
      assert.equal(anonymous.status, 401);
      await anonymous.text();
      // Student B cannot point their own run at A's run either.
      await setBaseline(r.foreign, r.sameProtocol, "studentB", REJECTED);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM run_baselines").first()).n, 0);
      const forOwner = await detail(r.target, "studentA");
      const forReviewer = await detail(r.target, "mentor1");
      const forViewer = await detail(r.target, "mentor3");
      assert.equal(forOwner.permissions.canSetBaseline, true);
      assert.equal(forReviewer.permissions.canSetBaseline, true);
      assert.equal(forViewer.permissions.canSetBaseline, false);
      await detail(r.target, "mentor5", 403);
      // Superadmin is a reviewer in every scope.
      assert.equal((await setBaseline(r.target, r.sameProtocol, "root")).baseline.runId, r.sameProtocol);
      await setBaseline(r.target, null, "root");
    });

    // ================= Interpretation (FA3) =================
    const content = (marker) => ({
      whatItShows: `${marker}：本次准确率高于上一轮`, alternativeExplanations: "可能是随机种子差异",
      limitations: "只有一个种子", proposedNextStep: "增加种子数量再比较",
    });
    const interpret = (runId, expectedVersion, marker, { actor = "studentA", requestId = key("interp"), status = 200 } = {}) =>
      results({ action: "interpret", runId, requestId, expectedVersion, ...content(marker) }, actor, status);
    const interpretationRows = async (runId) => (await db.prepare("SELECT count(*) AS n FROM result_interpretations WHERE run_id = ?").bind(runId).first()).n;

    await t.test("interpretation: only the owning student writes, only for completed or failed runs", async () => {
      for (const actor of ["mentor1", "mentor3", "mentor4", "mentor5", "studentB", "root"]) {
        await interpret(r.interp, 0, "越权", { actor, status: 403 });
      }
      for (const runId of [r.waiting, r.canceled]) await interpret(runId, 0, "未结束", { status: [400, 409] });
      await interpret(r.foreign, 0, "他人", { status: 403 });
      assert.equal(await interpretationRows(r.interp), 0);
      const first = await interpret(r.interp, 0, "解读一");
      assert.equal(first.interpretation.version, 1);
      assert.equal(first.interpretation.authorUserId, 2101);
      assert.equal(first.interpretation.whatItShows, content("解读一").whatItShows);
      const onFailure = await interpret(r.interpFailed, 0, "失败解读");
      assert.equal(onFailure.interpretation.version, 1, "a failed run can be interpreted");
      const forOwner = await detail(r.interp, "studentA");
      const forMentor = await detail(r.interp, "mentor1");
      assert.equal(forOwner.permissions.canInterpret, true);
      assert.equal(forMentor.permissions.canInterpret, false);
      assert.equal(forMentor.interpretation.version, 1, "the reviewer sees it before reviewing");
      assert.equal(forMentor.review.state, "pending");
    });

    await t.test("interpretation: versioned with a stale-version conflict and requestId idempotency", async () => {
      const current = (await detail(r.interp)).interpretation?.version ?? 0;
      const requestId = key("interp");
      const next = await interpret(r.interp, current, "解读二", { requestId });
      assert.equal(next.interpretation.version, current + 1);
      const rows = await interpretationRows(r.interp);
      const replay = await interpret(r.interp, current, "解读二", { requestId });
      assert.equal(replay.interpretation.version, current + 1, "same requestId → same version");
      assert.equal(await interpretationRows(r.interp), rows, "replay writes nothing");
      await interpret(r.interp, current, "过期", { status: 409 });
      await interpret(r.interp, current + 5, "未来版本", { status: 409 });
      assert.equal(await interpretationRows(r.interp), rows);
      // A late replay of an already-applied request is still a replay, not a conflict.
      const late = await interpret(r.interp, current, "解读二", { requestId });
      assert.equal(late.interpretation.version, current + 1);
      // A requestId is bound to its run: reusing it elsewhere never writes there.
      await interpret(r.interpFailed, 1, "复用", { requestId, status: [400, 409] });
      assert.equal(await interpretationRows(r.interpFailed), 1);
      const view = await detail(r.interp, "mentor1");
      assert.equal(view.interpretation.version, current + 1);
      assert.equal(view.interpretation.whatItShows, content("解读二").whatItShows);
      assert.ok(Array.isArray(view.interpretationVersions));
      assert.equal(view.interpretationVersions.length, current + 1, "history is kept");
      // Mentors and other students still cannot append a version.
      await interpret(r.interp, current + 1, "导师代写", { actor: "mentor1", status: 403 });
      await interpret(r.interp, current + 1, "同学代写", { actor: "studentB", status: 403 });
      assert.equal(await interpretationRows(r.interp), rows);
    });

    await t.test("interpretation: review remains possible without one", async () => {
      assert.equal(await interpretationRows(r.reviewNoInterp), 0);
      const view = await detail(r.reviewNoInterp, "mentor1");
      assert.equal(view.interpretation ?? null, null);
      const reviewed = await results({ action: "review", runId: r.reviewNoInterp, expectedVersion: view.review.version ?? 1,
        state: "needs_followup", hypothesisOutcome: "inconclusive", note: "需要学生补充解读" }, "mentor1");
      assert.equal(reviewed.version, (view.review.version ?? 1) + 1);
    });

    // ================= Progress draft (FA4) =================
    const draft = (runId, actor = "studentA", status = 200) => results({ action: "progress_draft", runId }, actor, status);
    const ACCEPTANCE_CLAIM = /验收通过|通过验收|已验收|评审通过|已通过评审|结果已接受|已被接受|已采纳|假设成立|假设得到(支持|证实|验证)|证实了假设/;

    await t.test("progress draft: writes nothing, cites the metrics source and PR, never claims a pending acceptance", async () => {
      assert.equal((await detail(r.interp)).review.state, "pending");
      const before = await tableCounts();
      const { draft: built } = await draft(r.interp);
      assert.deepEqual(await tableCounts(), before, "no row count changes in any table");
      assert.equal(built.kind, "项目");
      assert.equal(built.from.runId, r.interp);
      assert.equal(built.from.taskId, "task_rra");
      assert.equal(built.from.changeRequestId, "cr_a");
      const text = JSON.stringify(built);
      assert.ok(text.includes(PR_URL), "PR link included");
      assert.ok(text.includes("metrics.json"), "metrics source named");
      assert.ok(built.evidenceSources.some((source) => source.ref === PR_URL || source.ref.includes("/pull/12")));
      assert.ok(built.evidenceSources.every((source) => ["url", "git"].includes(source.sourceType)));
      const latest = (await detail(r.interp)).interpretation;
      if (latest) {
        assert.equal(built.from.interpretationVersion, latest.version);
        assert.ok(text.includes(latest.whatItShows), "summary comes from the latest interpretation");
      }
      assert.doesNotMatch(`${built.title}\n${built.summary}\n${built.evidence}`, ACCEPTANCE_CLAIM, "review is pending");
      assert.doesNotMatch(text, HEX64, "no full 64-hex hash");
      // Calling it twice is still a pure read.
      await draft(r.interp, "mentor1");
      assert.deepEqual(await tableCounts(), before);
    });

    await t.test("progress draft: no PR is never invented; no interpretation is reported as none; scope enforced", async () => {
      const { draft: built } = await draft(r.noPr);
      assert.equal(built.from.changeRequestId, "cr_a2");
      assert.equal(built.from.interpretationVersion, null);
      const text = JSON.stringify(built);
      assert.doesNotMatch(text, /\/pull\/\d+/, "no PR link when the change has none");
      assert.ok(text.includes("metrics.json"));
      assert.doesNotMatch(text, HEX64);
      assert.doesNotMatch(`${built.title}\n${built.summary}\n${built.evidence}`, ACCEPTANCE_CLAIM);
      // A failed or invalid run's draft must not read as accepted either.
      for (const runId of [r.invalid, r.interpFailed]) {
        const response = await call("/api/run-results", { actor: "studentA", method: "POST", body: { action: "progress_draft", runId } });
        const body = await readJson(response, [200, 400, 409]);
        if (response.status === 200) {
          assert.doesNotMatch(`${body.draft.title}\n${body.draft.summary}\n${body.draft.evidence}`, ACCEPTANCE_CLAIM);
          assert.doesNotMatch(JSON.stringify(body.draft), HEX64);
        }
      }
      const before = await tableCounts();
      for (const actor of ["studentB", "mentor3", "mentor4", "mentor5"]) await draft(r.interp, actor, 403);
      assert.deepEqual(await tableCounts(), before);
      assert.equal((await detail(r.interp, "studentA")).permissions.canDraftProgress, true);
      assert.equal((await detail(r.interp, "mentor1")).permissions.canDraftProgress, true);
      assert.equal((await detail(r.interp, "mentor3")).permissions.canDraftProgress, false);
    });

    // ================= Evidence report (FA4) =================
    const REPORT_KEYS = ["blockers", "changeRequests", "period", "runs", "studentId", "tasks"];
    const RUN_KEYS = ["endedAt", "failureReason", "interpreted", "metrics", "number", "reviewState", "runId", "status", "taskId", "technicalValidity"];
    const TASK_KEYS = ["created", "status", "taskId", "title", "versionsConfirmed"];
    const CHANGE_KEYS = ["createdAt", "id", "prNumber", "prUrl", "status", "taskId"];
    const BLOCKER_KEYS = ["kind", "runId", "taskId", "text"];
    const period = { from: day(-10), to: day(1) };
    const subset = (object, allowed, label) => {
      for (const name of Object.keys(object)) assert.ok(allowed.includes(name), `${label}: unexpected field ${name}`);
    };

    await t.test("evidence: scope follows canViewStudent", async () => {
      await evidence({ studentId: "rr-a", ...period }, "studentA");
      await evidence({ studentId: "rr-a", ...period }, "mentor1");
      await evidence({ studentId: "rr-a", ...period }, "mentor3");
      await evidence({ studentId: "rr-a", ...period }, "root");
      for (const actor of ["studentB", "mentor4", "mentor5"]) await evidence({ studentId: "rr-a", ...period }, actor, 403);
      await evidence({ studentId: "rr-b", ...period }, "studentA", 403);
      await evidence({ studentId: "rr-b", ...period }, "mentor4");
      const anonymous = await call(`/api/research-loop/evidence?${new URLSearchParams({ studentId: "rr-a", ...period })}`);
      assert.equal(anonymous.status, 401);
      await anonymous.text();
      const report = await evidence({ studentId: "rr-a", ...period });
      assert.equal(report.studentId, "rr-a");
      assert.deepEqual(report.period, period);
      assert.ok(report.tasks.every((task) => task.taskId !== "task_rrb"));
      assert.ok(report.runs.every((run) => run.runId !== r.foreign));
      assert.ok(report.changeRequests.every((change) => change.id !== "cr_b"));
    });

    await t.test("evidence: period at most 62 days and strict YYYY-MM-DD dates", async () => {
      await evidence({ studentId: "rr-a", from: "2026-01-01", to: "2026-03-03" }); // 61 days apart: within either counting
      await evidence({ studentId: "rr-a", from: "2026-01-01", to: "2026-03-05" }, "studentA", 400); // 63 days apart
      await evidence({ studentId: "rr-a", from: "2026-01-01", to: "2026-12-31" }, "studentA", 400);
      await evidence({ studentId: "rr-a", from: "2026-01-01", to: "2026-01-01" });
      const bad = [
        { from: "2026-03-01", to: "2026-02-01" },
        { from: "2026-13-01", to: "2026-13-05" },
        { from: "2026-02-30", to: "2026-03-02" },
        { from: "20261101", to: "20261103" },
        { from: "2026-11-1", to: "2026-11-03" },
        { from: "2026-11-01T00:00:00Z", to: "2026-11-03" },
        { from: "", to: "2026-11-03" },
        { to: "2026-11-03" },
        { from: "2026-11-01" },
        { from: "yesterday", to: "today" },
      ];
      for (const query of bad) await evidence({ studentId: "rr-a", ...query }, "studentA", 400);
      await evidence({ studentId: "missing", from: day(-3), to: day(0) }, "studentA", [403, 404]);
    });

    await t.test("evidence: a newer completed run clears an older failure blocker on the same task", async () => {
      const older = await failedRun({ taskId: "task_rra3", changeRequestId: "cr_a3" }, "磁盘已满");
      const first = await evidence({ studentId: "rr-a", ...period });
      const blocker = first.blockers.find((item) => item.kind === "run_failed" && item.runId === older);
      assert.ok(blocker, "the failure blocks while it is the latest outcome");
      assert.equal(blocker.taskId, "task_rra3");
      const listed = first.runs.find((run) => run.runId === older);
      assert.equal(listed.status, "failed");
      assert.equal(listed.failureReason, "磁盘已满");
      const newer = await validRun({ taskId: "task_rra3", changeRequestId: "cr_a3" }, 0.93);
      const second = await evidence({ studentId: "rr-a", ...period });
      assert.ok(!second.blockers.some((item) => item.kind === "run_failed" && item.runId === older), "cleared by the newer completed run");
      assert.ok(second.runs.some((run) => run.runId === older), "history is still listed");
      const newerRow = second.runs.find((run) => run.runId === newer);
      assert.equal(newerRow.status, "completed");
      assert.equal(newerRow.technicalValidity, "valid");
      assert.deepEqual(newerRow.metrics, { accuracy: 0.93 });
      // "Newer" follows run creation order (per-task run number), the same order the
      // stage bar uses: a failure blocks unless a later-registered run of the same
      // task completed. Check every listed failure against that rule.
      for (const run of second.runs.filter((item) => item.status === "failed")) {
        const cleared = second.runs.some((other) => other.taskId === run.taskId && other.status === "completed"
          && (other.number ?? 0) > (run.number ?? 0));
        const blocked = second.blockers.some((item) => item.kind === "run_failed" && item.runId === run.runId);
        assert.equal(blocked, !cleared, `failure ${run.runId} (#${run.number}) blocker must follow creation order`);
      }
    });

    await t.test("evidence: typed fields only, no hashes, no free content", async () => {
      // Plant content that must never reach the report.
      await results({ action: "comment", runId: r.target, requestId: key("comment"), body: "保密评论内容丙" }, "studentA");
      const report = await evidence({ studentId: "rr-a", ...period }, "mentor1");
      assert.deepEqual(Object.keys(report).sort(), REPORT_KEYS);
      subset(report.period, ["from", "to"], "period");
      for (const task of report.tasks) subset(task, TASK_KEYS, "task");
      for (const change of report.changeRequests) subset(change, CHANGE_KEYS, "changeRequest");
      for (const run of report.runs) subset(run, RUN_KEYS, "run");
      for (const blocker of report.blockers) {
        subset(blocker, BLOCKER_KEYS, "blocker");
        assert.ok(["run_failed", "change_failed", "task_unconfirmed"].includes(blocker.kind));
      }
      const text = JSON.stringify(report);
      assert.doesNotMatch(text, HEX64, "no 64-hex hash");
      assert.doesNotMatch(text, HEX40_PLUS, "no full commit SHA (not a typed field)");
      for (const secret of ["保密研究问题甲", "保密操作说明乙", "保密评论内容丙", "本次准确率高于上一轮", "可能是随机种子差异", "registry.lab", "lab://"]) {
        assert.ok(!text.includes(secret), `report leaks: ${secret}`);
      }
      const ids = report.runs.map((run) => run.runId);
      for (const id of [r.target, r.failed, r.interp, r.interpFailed]) assert.ok(ids.includes(id), `run ${id} in period`);
      for (const run of report.runs) {
        const rows = (await db.prepare("SELECT count(*) AS n FROM result_interpretations WHERE run_id = ?").bind(run.runId).first()).n;
        assert.equal(run.interpreted, rows > 0, `interpreted flag for ${run.runId}`);
      }
      const change = report.changeRequests.find((item) => item.id === "cr_a");
      assert.equal(change.prNumber, 12);
      assert.equal(change.prUrl, PR_URL);
      assert.equal(report.changeRequests.find((item) => item.id === "cr_a2")?.prNumber ?? null, null);
      // A period that ends before anything happened is empty, not a leak of everything.
      const empty = await evidence({ studentId: "rr-a", from: "2020-01-01", to: "2020-01-31" });
      assert.deepEqual([empty.tasks.length, empty.changeRequests.length, empty.runs.length], [0, 0, 0]);
    });

    await t.test("no outbound requests and referential integrity holds", async () => {
      assert.equal(outbound, 0);
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
  } finally {
    await mf.dispose();
  }
});
