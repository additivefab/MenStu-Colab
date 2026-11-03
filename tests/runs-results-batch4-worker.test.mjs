import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Batch 4 (results-contract.ts): baselines, student interpretations and
// progress drafts against the built Worker. Synthetic fixtures only; the lab
// runner is simulated by direct protocol calls and nothing leaves the sandbox.
const EVAL = "e".repeat(64);
const EVAL2 = "9".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const IMAGE = `registry.lab/train@${IMAGE_DIGEST}`;
const SHA_A = "1".repeat(40);
const SHA_B = "3".repeat(40);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("batch 4: baselines, interpretations and progress drafts", { timeout: 240_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "results-b4-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const personas = { studentA: "student", studentB: "student" };
  const cookie = (actor) => `tanyan_session=b4-${actor}; tanyan_persona=${personas[actor] ?? "management"}`;
  const call = (path, { actor, method = "GET", body } = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { cookie: cookie(actor), ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const expectJson = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    return JSON.parse(text);
  };
  const admin = (body) => call("/api/admin/lab", { actor: "root", method: "POST", body }).then((r) => expectJson(r));
  const runs = (body, actor = "studentA", status = 200) => call("/api/runs", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const results = (body, actor = "studentA", status = 200) => call("/api/run-results", { actor, method: "POST", body }).then((r) => expectJson(r, status));
  const detail = (runId, actor = "studentA", status = 200) => call(`/api/runs?runId=${runId}`, { actor }).then((r) => expectJson(r, status));
  let runnerToken;
  const lab = (body, status = 200) => mf.dispatchFetch(origin + "/api/lab/runs", {
    method: "POST", headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => expectJson(r, status));
  let keyCounter = 0;
  const key = (label = "k") => `${label}-${String(++keyCounter).padStart(6, "0")}`;

  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('b4-a', '基线测试甲', '博士', 2025, '实验', 1), ('b4-b', '基线测试乙', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (1201, 'b4-student-a', '基线测试甲', 'student', 'b4-a'), (1202, 'b4-student-b', '基线测试乙', 'student', 'b4-b'),
      (1203, 'b4-mentor-1', '审核导师一', 'mentor', NULL), (1204, 'b4-mentor-3', '只读导师', 'mentor', NULL),
      (1205, 'b4-mentor-4', '乙的导师', 'mentor', NULL), (1206, 'b4-root', '超级管理员', 'superadmin', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (1203, 'b4-a', 1, 1), (1204, 'b4-a', 0, 1), (1205, 'b4-b', 1, 1)`).run();
    for (const [id, actor] of [[1201, "studentA"], [1202, "studentB"], [1203, "mentor1"], [1204, "mentor3"], [1205, "mentor4"], [1206, "root"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`b4-${actor}`), id).run();
    }
    await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (88, 'synthetic-lab', 'Organization')").run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch) VALUES
      ('b4-a', 6001, 88, 'synthetic-lab/a-research', 'main'), ('b4-b', 6002, 88, 'synthetic-lab/b-research', 'main')`).run();
    await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_agentb4', '代理', 'agent', ?)").bind("f".repeat(64)).run();
    const tasks = [["task_b4a", "b4-a", 1201, "降噪实验"], ["task_b4a2", "b4-a", 1201, "另一项任务"], ["task_b4b", "b4-b", 1202, "乙的任务"]];
    for (const [taskId, studentId, userId, title] of tasks) {
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
        VALUES (?, ?, ?, 'confirmed', 1, 1, ?, ?, ?)`).bind(taskId, studentId, title, userId, `seed-${taskId}`, `seed-${taskId}`).run();
      await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
        budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
        VALUES (?, 1, ?, '合成问题', '合成说明', '合成标准', '{"maxGpuCount":2,"maxWalltimeMinutes":600}', ?, ?, ?, CURRENT_TIMESTAMP)`)
        .bind(taskId, title, "d".repeat(64), userId, userId).run();
    }
    await db.prepare("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_b4a', 1201, 'codex', 'rnr_agentb4'), ('cred_b4b', 1202, 'codex', 'rnr_agentb4')").run();
    const seedChange = async (crId, taskId, studentId, cred, repo, sha) => {
      await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
        base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
        VALUES (?, ?, 1, ?, 'codex', ?, ?, ?, ?, 'change_ready', ?, 1201)`)
        .bind(`att_${crId}`, taskId, studentId, cred, repo, "0".repeat(40), "d".repeat(64), `seed-${crId}`).run();
      await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`).bind(crId, taskId, `att_${crId}`, studentId, repo, "0".repeat(40), `tanyan/${crId}`, sha).run();
    };
    await seedChange("cr_b4a", "task_b4a", "b4-a", "cred_b4a", 6001, SHA_A);
    await seedChange("cr_b4a2", "task_b4a2", "b4-a", "cred_b4a", 6001, SHA_A);
    await seedChange("cr_b4b", "task_b4b", "b4-b", "cred_b4b", 6002, SHA_B);

    const runner = await admin({ action: "register_runner", label: "GPU 服务器", kind: "compute" });
    runnerToken = runner.token;
    const entry = (studentId, name, protocol) => admin({
      action: "register_entrypoint", studentId, name, argv: ["python", "train.py"], imageRef: IMAGE, evaluationProtocolSha256: protocol,
      paramsSchema: { lr: { type: "number", required: true, minimum: 0, maximum: 1 } },
    }).then((r) => r.entrypoint.id);
    const epA = await entry("b4-a", "train", EVAL);
    const epA2 = await entry("b4-a", "train-v2", EVAL2);
    const epB = await entry("b4-b", "train", EVAL);
    const policy = { schema: "tanyan.egress/v1", allowedExtensions: [".json", ".txt"], maxFileBytes: 1000, maxTotalBytes: 5000, allowImages: false, blockDatasetHashMatches: true };
    const dataset = (await admin({ action: "register_dataset", label: "合成数据", runnerId: runner.runner.id, manifestSha256: "a".repeat(64), splitManifestSha256: "b".repeat(64), egressPolicy: policy })).dataset.id;
    for (const studentId of ["b4-a", "b4-b"]) await admin({ action: "grant_dataset", datasetVersionId: dataset, studentId });

    const metricsContent = (protocol = EVAL, accuracy = 0.91) => JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: protocol, split: "test", values: { accuracy } });
    const fileItem = (relativePath, content, kind = "other") => ({
      artifact: { relativePath, sha256: sha256(content), sizeBytes: Buffer.byteLength(content), kind, egressDecision: "published", egressReason: "runner", labLocator: `lab://out/${relativePath}` },
      published: { relativePath, contentBase64: Buffer.from(content).toString("base64") },
    });
    const create = (opts = {}) => runs({
      action: "create", taskId: opts.taskId ?? "task_b4a", changeRequestId: opts.cr ?? "cr_b4a", entrypointId: opts.entrypoint ?? epA,
      params: { lr: opts.lr ?? 0.1 }, datasetVersionId: dataset, resources: { gpuCount: 1, walltimeMinutes: 60, memoryGb: 16 },
      idempotencyKey: key("create"),
    }, opts.actor ?? "studentA");
    /** Creates, approves, claims and finishes a run. outcome: "valid" | "invalid" | "failed". */
    const finished = async (opts = {}) => {
      const run = await create(opts);
      await runs({ action: "approve", runId: run.runId, runSpecSha256: run.runSpecSha256 }, opts.approver ?? "mentor1");
      const { work } = await lab({ action: "claim" });
      assert.equal(work?.runId, run.runId);
      const outcome = opts.outcome ?? "valid";
      if (outcome === "failed") {
        await lab({ action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "failed", exitCode: 1, manifest: null });
        return run;
      }
      const metrics = fileItem("metrics.json", metricsContent(opts.protocol ?? EVAL, opts.accuracy), "metrics");
      const items = outcome === "invalid" ? [fileItem("log.txt", "trained", "log")] : [metrics];
      const manifest = {
        schema: "tanyan.manifest/v1", runId: work.runId, attempt: work.attempt, runSpecSha256: work.runSpecSha256, approvalId: work.approvalId,
        repository: { repositoryId: work.spec.repository.repositoryId, executedCommitSha: work.spec.executedCommitSha },
        inputs: { datasetVersionId: work.spec.dataset.versionId, manifestSha256: work.spec.dataset.manifestSha256,
          splitManifestSha256: work.spec.dataset.splitManifestSha256, evaluationProtocolSha256: work.spec.evaluationProtocolSha256, seeds: [7] },
        environment: { imageDigest: IMAGE_DIGEST, driverVersion: "550.00", gpuModel: "synthetic" },
        execution: { runnerId: runner.runner.id, schedulerJobId: "1", submitTag: work.submitTag, entrypointId: work.spec.entrypoint.id,
          startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T01:00:00Z", exitCode: 0 },
        metricsArtifactPath: outcome === "invalid" ? null : "metrics.json", artifacts: items.map((item) => item.artifact),
      };
      const done = await lab({ action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "completed", exitCode: 0, manifest, publishedFiles: items.map((item) => item.published) });
      assert.equal(done.status, "completed");
      assert.equal(done.technicalValidity, outcome === "invalid" ? "unknown" : "valid");
      return run;
    };
    const events = async (runId) => (await db.prepare("SELECT sequence, from_status, to_status, actor_type, actor_id, payload_json FROM run_events WHERE run_id = ? ORDER BY sequence").bind(runId).all()).results;
    const count = async (table) => (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
    const runNumber = async (runId) => {
      const { task_id: taskId } = await db.prepare("SELECT task_id FROM runs WHERE id = ?").bind(runId).first();
      const rows = (await db.prepare("SELECT id, created_at FROM runs WHERE task_id = ?").bind(taskId).all()).results;
      rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
      return rows.findIndex((row) => row.id === runId) + 1;
    };

    const a1 = await finished({ lr: 0.1, accuracy: 0.8 });
    const a2 = await finished({ lr: 0.2, accuracy: 0.91 });
    const aOtherTask = await finished({ taskId: "task_b4a2", cr: "cr_b4a2", lr: 0.3 });
    const aProtocol2 = await finished({ entrypoint: epA2, protocol: EVAL2, lr: 0.4 });
    const aInvalid = await finished({ lr: 0.5, outcome: "invalid" });
    const aFailed = await finished({ lr: 0.6, outcome: "failed" });
    const b1 = await finished({ taskId: "task_b4b", cr: "cr_b4b", entrypoint: epB, actor: "studentB", approver: "mentor4" });
    const aWaiting = await create({ lr: 0.7 });
    const aCanceled = await create({ lr: 0.8 });
    await runs({ action: "cancel", runId: aCanceled.runId });

    await t.test("baseline: happy path by the owner, spec and approval untouched, audited", async () => {
      const specBefore = await db.prepare("SELECT run_spec_sha256, approval_id FROM runs WHERE id = ?").bind(a2.runId).first();
      const canonicalBefore = (await db.prepare("SELECT canonical_json FROM run_specs WHERE sha256 = ?").bind(specBefore.run_spec_sha256).first()).canonical_json;
      const approvalBefore = await db.prepare("SELECT * FROM run_approvals WHERE id = ?").bind(specBefore.approval_id).first();
      const eventsBefore = (await events(a2.runId)).length;

      const set = await runs({ action: "set_baseline", runId: a2.runId, baselineRunId: a1.runId });
      assert.deepEqual(Object.keys(set).sort(), ["baseline", "runId"]);
      assert.equal(set.runId, a2.runId);
      const { baseline } = set;
      assert.equal(baseline.runId, a1.runId);
      assert.equal(baseline.taskId, "task_b4a");
      assert.equal(baseline.taskTitle, "降噪实验");
      assert.equal(baseline.number, await runNumber(a1.runId));
      assert.equal(baseline.executedCommitShort, SHA_A.slice(0, 7));
      assert.deepEqual(baseline.metrics, { accuracy: 0.8 });
      assert.equal(baseline.evaluationProtocolSha256, EVAL);
      assert.equal(baseline.protocolMatches, true);
      assert.equal(baseline.setByUserId, 1201);
      assert.equal(typeof baseline.setAt, "string");

      // The baseline is never part of the spec, its hash or the approval.
      const specAfter = await db.prepare("SELECT run_spec_sha256, approval_id FROM runs WHERE id = ?").bind(a2.runId).first();
      assert.deepEqual(specAfter, specBefore);
      const canonicalAfter = (await db.prepare("SELECT canonical_json FROM run_specs WHERE sha256 = ?").bind(specAfter.run_spec_sha256).first()).canonical_json;
      assert.equal(canonicalAfter, canonicalBefore);
      assert.equal(sha256(canonicalAfter), a2.runSpecSha256);
      assert.ok(!canonicalAfter.includes(a1.runId));
      assert.deepEqual(await db.prepare("SELECT * FROM run_approvals WHERE id = ?").bind(specBefore.approval_id).first(), approvalBefore);

      const log = await events(a2.runId);
      assert.equal(log.length, eventsBefore + 1);
      const last = log.at(-1);
      assert.deepEqual({ from: last.from_status, to: last.to_status, type: last.actor_type, id: last.actor_id },
        { from: "completed", to: "completed", type: "user", id: "1201" });
      assert.deepEqual(JSON.parse(last.payload_json), { action: "baseline_set", baselineRunId: a1.runId, previousBaselineRunId: null });
      // Re-setting the same baseline is a no-op (no duplicate event).
      await runs({ action: "set_baseline", runId: a2.runId, baselineRunId: a1.runId });
      assert.equal((await events(a2.runId)).length, eventsBefore + 1);

      const view = await detail(a2.runId);
      assert.equal(view.baseline.runId, a1.runId);
      assert.equal(view.run.runSpecSha256, a2.runSpecSha256);
      const candidates = Object.fromEntries(view.baselineCandidates.map((item) => [item.runId, item]));
      assert.deepEqual(Object.keys(candidates).sort(), [a1.runId, aOtherTask.runId, aProtocol2.runId].sort(),
        "only completed, technically valid runs of the same student, never the run itself");
      assert.equal(candidates[aProtocol2.runId].protocolMatches, false);
      assert.equal(candidates[a1.runId].protocolMatches, true);
      assert.equal(candidates[aOtherTask.runId].taskTitle, "另一项任务");
      assert.equal(candidates[aOtherTask.runId].number, 1);
      assert.equal(typeof candidates[a1.runId].endedAt, "string");

      // Any of the student's tasks; reviewer in scope may set; superadmin too.
      const crossTask = await runs({ action: "set_baseline", runId: a2.runId, baselineRunId: aOtherTask.runId }, "mentor1");
      assert.equal(crossTask.baseline.taskId, "task_b4a2");
      assert.equal(crossTask.baseline.setByUserId, 1203);
      assert.equal((await runs({ action: "set_baseline", runId: a2.runId, baselineRunId: a1.runId }, "root")).baseline.setByUserId, 1206);
      // A run still waiting for approval may already name its comparison target.
      assert.equal((await runs({ action: "set_baseline", runId: aWaiting.runId, baselineRunId: a1.runId })).baseline.runId, a1.runId);
    });

    await t.test("baseline: every rejection (other student, not completed, invalid, self, scope)", async () => {
      const reject = async (baselineRunId, status, code, actor = "studentA", runId = a2.runId) => {
        const body = await runs({ action: "set_baseline", runId, baselineRunId }, actor, status);
        if (code) assert.equal(body.code, code);
        assert.match(body.error, /[一-鿿]/u, "Chinese error");
      };
      await reject(b1.runId, 404, "BASELINE_NOT_FOUND");
      await reject("run_missing", 404, "BASELINE_NOT_FOUND");
      await reject(aWaiting.runId, 409, "BASELINE_NOT_COMPLETED");
      await reject(aFailed.runId, 409, "BASELINE_NOT_COMPLETED");
      await reject(aCanceled.runId, 409, "BASELINE_NOT_COMPLETED");
      await reject(aInvalid.runId, 409, "BASELINE_NOT_VALID");
      await reject(a2.runId, 400, "BASELINE_SELF");
      await reject("bad id!", 400, "INVALID_INPUT");
      await runs({ action: "set_baseline", runId: a2.runId }, "studentA", 400);
      // Scope: out-of-scope users and view-only mentors cannot set or clear.
      await reject(a1.runId, 403, "FORBIDDEN", "studentB");
      await reject(a1.runId, 403, "FORBIDDEN", "mentor4");
      await reject(a1.runId, 403, "FORBIDDEN", "mentor3");
      await reject(null, 403, "FORBIDDEN", "mentor3");
      // Student B cannot borrow student A's run for their own run either.
      await reject(a1.runId, 404, "BASELINE_NOT_FOUND", "studentB", b1.runId);
      await detail(b1.runId, "studentA", 403);
      assert.equal((await detail(a2.runId)).baseline.runId, a1.runId, "rejections leave the baseline unchanged");
    });

    await t.test("baseline: protocol mismatch is flagged, never hidden (T21); null clears it", async () => {
      const mismatch = await runs({ action: "set_baseline", runId: a2.runId, baselineRunId: aProtocol2.runId });
      assert.equal(mismatch.baseline.protocolMatches, false);
      assert.equal(mismatch.baseline.evaluationProtocolSha256, EVAL2);
      const view = await detail(a2.runId, "mentor1");
      assert.equal(view.baseline.protocolMatches, false);
      assert.equal(view.spec.evaluationProtocolSha256, EVAL);
      // From the other side, the candidate list flags the same mismatch.
      const reverse = await detail(aProtocol2.runId);
      assert.equal(reverse.baselineCandidates.find((item) => item.runId === a1.runId).protocolMatches, false);

      const before = (await events(a2.runId)).length;
      assert.deepEqual(await runs({ action: "set_baseline", runId: a2.runId, baselineRunId: null }, "mentor1"), { runId: a2.runId, baseline: null });
      const cleared = (await events(a2.runId)).at(-1);
      assert.equal(cleared.actor_id, "1203");
      assert.deepEqual(JSON.parse(cleared.payload_json), { action: "baseline_cleared", previousBaselineRunId: aProtocol2.runId });
      assert.equal((await detail(a2.runId)).baseline, null);
      await runs({ action: "set_baseline", runId: a2.runId, baselineRunId: null });
      assert.equal((await events(a2.runId)).length, before + 1, "clearing an empty baseline writes nothing");
      await runs({ action: "set_baseline", runId: a2.runId, baselineRunId: a1.runId });
    });

    await t.test("interpretation: owner only, terminal only, versioned, idempotent, audited", async () => {
      const body = (overrides = {}) => ({
        action: "interpret", runId: a2.runId, requestId: key("interp"), expectedVersion: 0,
        whatItShows: "新的降噪模块让准确率从 0.80 提高到 0.91", alternativeExplanations: "也可能是学习率不同",
        limitations: "只跑了一个随机种子", proposedNextStep: "固定学习率，多跑三个种子", ...overrides,
      });
      for (const actor of ["mentor1", "mentor3", "root", "studentB", "mentor4"]) {
        const refused = await results(body(), actor, 403);
        assert.match(refused.error, /[一-鿿]/u);
      }
      assert.equal((await results(body({ runId: aWaiting.runId }), "studentA", 409)).code, "RUN_NOT_TERMINAL");
      assert.equal((await results(body({ runId: aCanceled.runId }), "studentA", 409)).code, "RUN_NOT_TERMINAL");
      await results(body({ whatItShows: "" }), "studentA", 400);
      const tooLong = await results(body({ limitations: "长".repeat(4001) }), "studentA", 400);
      assert.match(tooLong.error, /4000/);
      await results(body({ expectedVersion: -1 }), "studentA", 400);
      await results(body({ requestId: "short" }), "studentA", 400);
      assert.equal(await count("result_interpretations"), 0);

      const eventsBefore = (await events(a2.runId)).length;
      const first = body();
      const saved = await results(first);
      assert.deepEqual(Object.keys(saved), ["interpretation"]);
      assert.deepEqual(saved.interpretation, {
        version: 1, authorUserId: 1201, authorName: "基线测试甲", createdAt: saved.interpretation.createdAt,
        whatItShows: first.whatItShows, alternativeExplanations: first.alternativeExplanations,
        limitations: first.limitations, proposedNextStep: first.proposedNextStep,
      });
      // Replay with the same requestId returns the stored version, even after it went stale.
      assert.deepEqual(await results(first), saved);
      assert.equal(await count("result_interpretations"), 1);
      const stale = await results(body({ whatItShows: "并发覆盖" }), "studentA", 409);
      assert.equal(stale.code, "STALE_VERSION");
      const second = await results(body({ expectedVersion: 1, whatItShows: "修订：准确率提高 0.11", proposedNextStep: "" }));
      assert.equal(second.interpretation.version, 2);
      assert.equal(second.interpretation.proposedNextStep, "");
      await results(body({ expectedVersion: 5 }), "studentA", 409);
      // A requestId is bound to one run.
      assert.equal((await results({ ...first, runId: a1.runId }, "studentA", 409)).code, "IDEMPOTENCY_CONFLICT");
      // Failed runs are terminal too.
      assert.equal((await results(body({ runId: aFailed.runId, whatItShows: "显存不足导致失败" }))).interpretation.version, 1);

      const log = (await events(a2.runId)).slice(eventsBefore);
      assert.equal(log.length, 2, "one event per saved version, none for replays or conflicts");
      for (const [index, event] of log.entries()) {
        assert.deepEqual({ from: event.from_status, to: event.to_status, type: event.actor_type, id: event.actor_id },
          { from: "completed", to: "completed", type: "user", id: "1201" });
        assert.deepEqual(JSON.parse(event.payload_json), { action: "interpretation_saved", version: index + 1 }, "no free text in the audit payload");
      }

      const own = await detail(a2.runId);
      assert.equal(own.interpretation.version, 2);
      assert.deepEqual(own.interpretationVersions.map((item) => item.version), [2, 1]);
      assert.deepEqual(own.permissions, { ...own.permissions, canSetBaseline: true, canInterpret: true, canDraftProgress: true });
      const mentor = await detail(a2.runId, "mentor1");
      assert.equal(mentor.interpretation.whatItShows, "修订：准确率提高 0.11", "visible to the reviewer before review");
      assert.deepEqual(mentor.permissions, { ...mentor.permissions, canSetBaseline: true, canInterpret: false, canDraftProgress: true });
      const readOnly = await detail(a2.runId, "mentor3");
      assert.deepEqual(readOnly.permissions, { ...readOnly.permissions, canSetBaseline: false, canInterpret: false, canDraftProgress: false });
      assert.equal((await detail(aWaiting.runId)).permissions.canInterpret, false);
      assert.equal((await detail(aFailed.runId)).permissions.canInterpret, true);
      // Review stays allowed without an interpretation (the UI warns).
      await results({ action: "review", runId: a1.runId, expectedVersion: 1, state: "accepted", hypothesisOutcome: "supported" }, "mentor1");
    });

    await t.test("progress draft: factual content, metric source, PR, missing interpretation; nothing saved", async () => {
      const tables = ["result_interpretations", "run_events", "progress_entries", "progress_evidence_sources", "run_baselines"];
      const before = await Promise.all(tables.map(count));

      const bare = (await results({ action: "progress_draft", runId: a1.runId })).draft;
      const number1 = await runNumber(a1.runId);
      assert.equal(bare.kind, "项目");
      assert.equal(bare.title, `降噪实验 · 运行 #${number1} 结果`);
      assert.match(bare.summary, /尚未填写结果解读/);
      assert.match(bare.summary, /技术有效性：有效/);
      assert.match(bare.evidence, new RegExp(`metrics\\.json，sha256 ${sha256(metricsContent(EVAL, 0.8)).slice(0, 12)}`));
      assert.match(bare.evidence, /accuracy = 0\.8/);
      assert.match(bare.evidence, new RegExp(SHA_A));
      assert.match(bare.evidence, /cr_b4a（尚无 PR 链接）/);
      assert.doesNotMatch(bare.evidence, /https:\/\/github\.com\/[^ ]+\/pull/);
      assert.deepEqual(bare.evidenceSources, [{ sourceType: "git", label: `执行提交 ${SHA_A.slice(0, 7)}`, ref: `https://github.com/synthetic-lab/a-research/commit/${SHA_A}` }]);
      assert.deepEqual(bare.from, { taskId: "task_b4a", runId: a1.runId, changeRequestId: "cr_b4a", interpretationVersion: null });

      const prUrl = "https://github.com/synthetic-lab/a-research/pull/12";
      await db.prepare("UPDATE change_requests SET pr_url = ?, pr_number = 12 WHERE id = 'cr_b4a'").bind(prUrl).run();
      const full = (await results({ action: "progress_draft", runId: a2.runId }, "mentor1")).draft;
      assert.match(full.summary, /学生解读（第 2 版）/);
      assert.match(full.summary, /修订：准确率提高 0\.11/);
      assert.doesNotMatch(full.summary, /尚未填写/);
      assert.doesNotMatch(full.summary, /建议的下一步/, "empty fields are not invented");
      assert.match(full.evidence, new RegExp(`PR #12 ${prUrl}`));
      assert.deepEqual(full.evidenceSources[0], { sourceType: "url", label: "PR #12", ref: prUrl });
      assert.equal(full.evidenceSources[1].sourceType, "git");
      assert.deepEqual(full.from, { taskId: "task_b4a", runId: a2.runId, changeRequestId: "cr_b4a", interpretationVersion: 2 });

      // Failed run without metrics: says so instead of inventing numbers.
      const failed = (await results({ action: "progress_draft", runId: aFailed.runId })).draft;
      assert.match(failed.evidence, /没有正式指标/);
      assert.match(failed.summary, /失败/);
      assert.match(failed.summary, /显存不足导致失败/);

      for (const actor of ["mentor3", "studentB", "mentor4"]) await results({ action: "progress_draft", runId: a1.runId }, actor, 403);
      await results({ action: "progress_draft", runId: "run_missing" }, "studentA", 404);
      assert.deepEqual(await Promise.all(tables.map(count)), before, "a draft writes nothing");
    });

    await t.test("scope isolation for student B's own run, and nothing left the sandbox", async () => {
      await runs({ action: "set_baseline", runId: b1.runId, baselineRunId: null }, "studentA", 403);
      await runs({ action: "set_baseline", runId: b1.runId, baselineRunId: null }, "mentor1", 403);
      await results({ action: "interpret", runId: b1.runId, requestId: key("interp"), expectedVersion: 0, whatItShows: "越权" }, "studentA", 403);
      await results({ action: "interpret", runId: b1.runId, requestId: key("interp"), expectedVersion: 0, whatItShows: "导师代写" }, "mentor4", 403);
      await results({ action: "progress_draft", runId: b1.runId }, "studentA", 403);
      await results({ action: "progress_draft", runId: b1.runId }, "mentor1", 403);
      const own = await detail(b1.runId, "studentB");
      assert.deepEqual(own.baselineCandidates, [], "student A's runs are never offered to student B");
      assert.equal(own.baseline, null);
      const mine = await results({ action: "interpret", runId: b1.runId, requestId: key("interp"), expectedVersion: 0, whatItShows: "乙的解读" }, "studentB");
      assert.equal(mine.interpretation.version, 1, "versions are per run");
      assert.equal((await results({ action: "progress_draft", runId: b1.runId }, "mentor4")).draft.from.interpretationVersion, 1);
      assert.equal(outbound, 0, "no external requests");
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
  } finally {
    await mf.dispose();
  }
});
