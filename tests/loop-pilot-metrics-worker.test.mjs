import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { median, p90, parsePilotPeriod } from "../lib/loop-pilot-metrics.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Pilot process metrics (plan G5) against the built Worker. Synthetic data with
// hand-computed answers; outbound network is blocked.
const IMAGE = `registry.lab/train@sha256:${"c".repeat(64)}`;
const SHA = "e".repeat(40);
const METRIC_KEYS = [
  "caveat", "computable", "definition", "denominator", "group", "key", "kind", "label", "median", "numerator",
  "p90", "reason", "sampleSize", "unit", "value",
].sort();
const REPORT_KEYS = ["metrics", "note", "percentileMethod", "period"];
const ALL_METRICS = [
  "closed_loop_completion", "guidance_to_first_pr", "confirmation_to_first_pr", "change_review_time",
  "run_queue_time", "run_execution_time", "attempt_queue_time", "attempt_execution_time",
  "tokens_per_attempt", "tokens_per_task", "agent_wall_minutes_per_attempt",
  "run_failure_recovery", "attempt_failure_recovery", "duplicate_jobs", "reproduction_ratio", "mentor_evidence_lookup_time",
];

async function startWorker() {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const state = { outbound: 0 };
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "pilot-metrics-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { state.outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  return { mf, state };
}

const personas = { studentA: "student" };
function caller(mf) {
  return async (query, actor, expected = 200) => {
    const cookie = actor ? `tanyan_session=pm-${actor}; tanyan_persona=${personas[actor] ?? "management"}` : "";
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    const response = await mf.dispatchFetch(`http://localhost/api/admin/pilot-metrics${qs}`, { headers: { cookie } });
    const text = await response.text();
    assert.equal(response.status, expected, `${actor ?? "anonymous"} ${JSON.stringify(query)}: ${text}`);
    assert.match(response.headers.get("cache-control") ?? "", /private/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const body = JSON.parse(text);
    if (expected >= 400) assert.match(body.error, /[一-鿿]/, "Chinese error message");
    return body;
  };
}

async function seed(db) {
  await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
    ('pm-a', '试点甲', '博士', 2025, '实验', 1), ('pm-b', '试点乙', '硕士', 2025, '实验', 1)`).run();
  await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
    (3101, 'pm-student-a', '试点甲', 'student', 'pm-a'), (3102, 'pm-student-b', '试点乙', 'student', 'pm-b'),
    (3103, 'pm-mentor', '试点导师', 'mentor', NULL), (3105, 'pm-root', '超级管理员', 'superadmin', NULL),
    (3106, 'pm-pending', '待授权', 'pending', NULL)`).run();
  await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
    (3103, 'pm-a', 1, 1), (3103, 'pm-b', 1, 1)`).run();
  for (const [id, actor] of [[3101, "studentA"], [3103, "mentor"], [3105, "root"], [3106, "pending"]]) {
    await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
      .bind(digest(`pm-${actor}`), id).run();
  }
  await db.prepare(`INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES
    ('rnr_pm_agent', '代理', 'agent', ?), ('rnr_pm_gpu', 'GPU 一', 'compute', ?), ('rnr_pm_gpu2', 'GPU 二', 'compute', ?)`)
    .bind("8".repeat(64), "7".repeat(64), "6".repeat(64)).run();
  await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES
    ('cred_pm_a', 3101, 'codex', 'rnr_pm_agent'), ('cred_pm_b', 3102, 'claude', 'rnr_pm_agent')`).run();
  await db.prepare(`INSERT INTO registered_entrypoints(id, github_repository_id, name, argv_json, image_ref, created_by_user_id)
    VALUES ('ep_pm', 7101, 'train', '["python","train.py"]', ?, 3105)`).bind(IMAGE).run();
  await db.prepare(`INSERT INTO dataset_versions(id, label, runner_id, manifest_sha256, egress_policy_json, created_by_user_id)
    VALUES ('ds_pm', '合成数据', 'rnr_pm_gpu', ?, '{}', 3105)`).bind("a".repeat(64)).run();
  const guidance = await db.prepare(`INSERT INTO student_guidance_notes(student_id, mentor_user_id, content, created_at)
    VALUES ('pm-a', 3103, '合成意见', '2026-10-02 00:00:00') RETURNING id`).first();

  const owner = (studentId) => (studentId === "pm-a" ? 3101 : 3102);
  const task = async (id, studentId, confirmedAt, { guidanceId = null, budget = "{}" } = {}) => {
    await db.prepare(`INSERT INTO research_tasks(id, student_id, source_guidance_note_id, title, status, current_version, confirmed_version,
      created_by_user_id, create_mutation_id, last_mutation_id, created_at) VALUES (?, ?, ?, '合成任务', ?, 1, ?, ?, ?, ?, '2026-09-01 00:00:00')`)
      .bind(id, studentId, guidanceId, confirmedAt ? "confirmed" : "draft", confirmedAt ? 1 : null, owner(studentId), `c-${id}`, `m-${id}`).run();
    await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
      budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at) VALUES (?, 1, '合成任务', '问题', '说明', '标准', ?, ?, ?, ?, ?)`)
      .bind(id, budget, "d".repeat(64), owner(studentId), confirmedAt ? 3103 : null, confirmedAt).run();
  };
  await task("task_pm1", "pm-a", "2026-10-02 02:00:00", { guidanceId: guidance.id });
  await task("task_pm2", "pm-b", "2026-10-05 00:00:00");
  await task("task_pm3", "pm-a", "2026-10-07 00:00:00", { budget: JSON.stringify({ reproTolerance: 0.001 }) });
  await task("task_pm4", "pm-b", "2026-10-10 00:00:00");
  await task("task_pm5", "pm-a", null);
  await task("task_pm6", "pm-a", "2026-09-20 00:00:00");

  const attempt = (id, taskId, studentId, status, createdAt, startedAt, endedAt, usage = {}) => db.prepare(`INSERT INTO agent_attempts(id, task_id,
    task_version, student_id, provider, credential_profile_id, github_repository_id, base_commit_sha, context_snapshot_sha256, status,
    idempotency_key, usage_json, requested_by_user_id, created_at, started_at, ended_at) VALUES (?, ?, 1, ?, ?, ?, 7101, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, taskId, studentId, studentId === "pm-a" ? "codex" : "claude", studentId === "pm-a" ? "cred_pm_a" : "cred_pm_b", SHA, "d".repeat(64),
      status, `idem-${id}`, JSON.stringify(usage), owner(studentId), createdAt, startedAt, endedAt).run();
  await attempt("att_pm1", "task_pm1", "pm-a", "change_ready", "2026-10-02 03:00:00", "2026-10-02 03:10:00", "2026-10-02 03:40:00",
    { provider: "codex", inputTokens: 1000, outputTokens: 200, agentWallSeconds: 1500 });
  await attempt("att_pm2", "task_pm2", "pm-b", "failed", "2026-10-05 01:00:00", "2026-10-05 01:20:00", "2026-10-05 01:50:00",
    { provider: "claude", inputTokens: 3000, outputTokens: 1000, agentWallSeconds: 1800 });
  await attempt("att_pm3", "task_pm2", "pm-b", "change_ready", "2026-10-05 02:00:00", "2026-10-05 02:05:00", "2026-10-05 02:35:00",
    { inputTokens: 500, outputTokens: 100 });
  await attempt("att_pm4", "task_pm4", "pm-b", "change_ready", "2026-10-10 01:00:00", "2026-10-10 01:01:00", "2026-10-10 05:00:00",
    { inputTokens: 2000, outputTokens: 0, agentWallSeconds: 600 });
  await db.prepare(`INSERT INTO agent_attempt_plans(attempt_id, plan_text, plan_sha256, decision, submitted_at)
    VALUES ('att_pm4', '计划', ?, 'approved', '2026-10-10 02:00:00')`).bind("f".repeat(64)).run();
  await attempt("att_pm5", "task_pm3", "pm-a", "change_ready", "2026-10-07 00:10:00", "2026-10-07 00:20:00", "2026-10-07 00:30:00");
  await attempt("att_pm6", "task_pm6", "pm-a", "change_ready", "2026-09-20 00:10:00", "2026-09-20 00:20:00", "2026-09-20 00:30:00",
    { inputTokens: 99999, outputTokens: 1 });

  const change = (id, taskId, attemptId, studentId, status, prNumber, createdAt, updatedAt, publishedAt = null) => db.prepare(`INSERT INTO change_requests(id, task_id,
    attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, pr_number, pr_url, status, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, 7101, ?, ?, ?, ?, '', ?, ?, ?, ?)`)
    .bind(id, taskId, attemptId, studentId, SHA, `tanyan/${id}`, SHA, prNumber, status, createdAt, updatedAt, publishedAt).run();
  await change("cr_pm1", "task_pm1", "att_pm1", "pm-a", "open", 11, "2026-10-02 03:40:00", "2026-10-02 05:40:00");
  // cr_pm3 was published after 0028, so its recorded published_at survives the later merge.
  await change("cr_pm3", "task_pm2", "att_pm3", "pm-b", "merged", 12, "2026-10-05 02:35:00", "2026-10-06 00:00:00", "2026-10-05 05:35:00");
  await change("cr_pm4", "task_pm4", "att_pm4", "pm-b", "open", 13, "2026-10-10 05:00:00", "2026-10-10 06:00:00");
  await change("cr_pm5", "task_pm3", "att_pm5", "pm-a", "open", 15, "2026-10-07 00:30:00", "2026-10-07 01:30:00");
  await change("cr_pm6", "task_pm6", "att_pm6", "pm-a", "open", 14, "2026-09-20 00:30:00", "2026-09-20 01:00:00");
  // A synchronize after publishing overwrote cr_pm4's updated_at: its open time is no longer recoverable.
  await db.prepare(`INSERT INTO github_webhook_deliveries(delivery_id, event, action, payload_sha256, summary_json, status)
    VALUES ('dlv-pm-1', 'pull_request', 'synchronize', ?, ?, 'processed')`).bind("1".repeat(64), JSON.stringify({ changeRequestId: "cr_pm4" })).run();

  let specs = 0;
  const spec = async (taskId, studentId) => {
    const sha = (++specs).toString(16).padStart(64, "0");
    await db.prepare(`INSERT INTO run_specs(sha256, canonical_json, task_id, task_version, student_id, github_repository_id, executed_commit_sha,
      entrypoint_id, dataset_version_id, created_by_user_id) VALUES (?, '{}', ?, 1, ?, 7101, ?, 'ep_pm', 'ds_pm', 3105)`)
      .bind(sha, taskId, studentId, SHA).run();
    return sha;
  };
  const run = (id, sha, number, taskId, studentId, status, times, { runner = "rnr_pm_gpu", job = null } = {}) => db.prepare(`INSERT INTO runs(id,
    run_spec_sha256, attempt, task_id, student_id, status, idempotency_key, submit_tag, runner_id, scheduler_job_id, created_by_user_id,
    created_at, queued_at, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3105, ?, ?, ?, ?)`)
    .bind(id, sha, number, taskId, studentId, status, `idem-${id}`, `tanyan-${id}`, runner, job, times[0], times[1], times[2], times[3]).run();
  const s1 = await spec("task_pm1", "pm-a");
  await run("run_pm1", s1, 1, "task_pm1", "pm-a", "completed", ["2026-10-03 00:00:00", "2026-10-03 00:00:00", "2026-10-03 00:30:00", "2026-10-03 01:30:00"]);
  await run("run_pm2", s1, 2, "task_pm1", "pm-a", "completed", ["2026-10-04 00:00:00", "2026-10-04 00:00:00", "2026-10-04 00:10:00", "2026-10-04 01:10:00"]);
  const s2 = await spec("task_pm2", "pm-b");
  await run("run_pm3", s2, 1, "task_pm2", "pm-b", "failed", ["2026-10-06 00:00:00", "2026-10-06 00:00:00", "2026-10-06 00:20:00", "2026-10-06 00:50:00"]);
  await run("run_pm4", s2, 2, "task_pm2", "pm-b", "completed", ["2026-10-06 01:00:00", "2026-10-06 01:00:00", "2026-10-06 01:40:00", "2026-10-06 02:40:00"]);
  const s3 = await spec("task_pm3", "pm-a");
  await run("run_pm5", s3, 1, "task_pm3", "pm-a", "completed", ["2026-10-07 01:00:00", "2026-10-07 01:00:00", "2026-10-07 01:20:00", "2026-10-07 02:20:00"]);
  await run("run_pm6", s3, 2, "task_pm3", "pm-a", "completed", ["2026-10-08 00:00:00", "2026-10-08 00:00:00", "2026-10-08 00:20:00", "2026-10-08 01:20:00"]);
  const s4 = await spec("task_pm3", "pm-a");
  await run("run_pm7", s4, 1, "task_pm3", "pm-a", "failed", ["2026-10-09 00:00:00", "2026-10-09 00:00:00", "2026-10-09 00:10:00", "2026-10-09 00:20:00"], { job: "job-1" });
  await run("run_pm8", s4, 2, "task_pm3", "pm-a", "canceled", ["2026-10-09 01:00:00", null, null, "2026-10-09 01:05:00"], { job: "job-1" });
  const s5 = await spec("task_pm3", "pm-a");
  await run("run_pm9", s5, 1, "task_pm3", "pm-a", "queued", ["2026-10-10 00:00:00", "2026-10-10 00:00:00", null, null], { runner: "rnr_pm_gpu2", job: "job-1" });
  const s6 = await spec("task_pm6", "pm-a");
  await run("run_pm10", s6, 1, "task_pm6", "pm-a", "completed", ["2026-09-21 00:00:00", "2026-09-21 00:00:00", "2026-09-21 00:05:00", "2026-09-21 01:00:00"]);

  const metrics = (values) => JSON.stringify({ schema: "tanyan.metrics/v1", split: "test", values });
  for (const [runId, values] of [["run_pm1", { acc: 0.9, loss: 0.3 }], ["run_pm2", { acc: 0.905, loss: 0.3 }], ["run_pm4", { acc: 0.8 }],
    ["run_pm5", { acc: 0.7 }], ["run_pm6", { acc: 0.705 }], ["run_pm10", { acc: 0.5 }]]) {
    await db.prepare(`INSERT INTO run_results(run_id, manifest_sha256, manifest_json, metrics_json, technical_validity) VALUES (?, ?, '{}', ?, 'valid')`)
      .bind(runId, "9".repeat(64), metrics(values)).run();
  }
  await db.prepare(`INSERT INTO result_reviews(run_id, state, reviewer_user_id) VALUES
    ('run_pm1', 'accepted', 3103), ('run_pm4', 'pending', NULL), ('run_pm5', 'rejected', 3103), ('run_pm10', 'accepted', 3103)`).run();
}

const byKey = (report) => Object.fromEntries(report.metrics.map((metric) => [metric.key, metric]));

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { keys.add(key); collectKeys(item, keys); }
  return keys;
}

test("percentile helpers and period parsing", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([5]), 5);
  const period = parsePilotPeriod(null, null, "2026-11-03T04:00:00.000Z");
  assert.deepEqual([period.from, period.to], ["2026-10-05", "2026-11-03"]);
  assert.throws(() => parsePilotPeriod("2026-10-01", null), /同时提供/);
  assert.throws(() => parsePilotPeriod("2025-01-01", "2026-10-01"), /366/);
});

test("pilot metrics: superadmin only, known answers, empty period, no per-student data", { timeout: 180_000 }, async (t) => {
  const { mf, state } = await startWorker();
  const get = caller(mf);
  try {
    const db = await applyD1Migrations(mf);
    await seed(db);
    const period = { from: "2026-10-01", to: "2026-10-31" };

    await t.test("only the superadmin may read", async () => {
      await get(period, null, 401);
      await get(period, "pending", 403);
      await get(period, "studentA", 403);
      await get(period, "mentor", 403);
      await get({ from: "2026-10-01" }, "root", 400);
      await get({ from: "2026-13-01", to: "2026-10-31" }, "root", 400);
      await get({ from: "2026-10-31", to: "2026-10-01" }, "root", 400);
    });

    await t.test("each metric matches the hand-computed answer", async () => {
      const report = await get(period, "root");
      assert.deepEqual(Object.keys(report).sort(), REPORT_KEYS);
      assert.deepEqual(report.period, period);
      assert.equal(report.note, "这些是流程指标，用于评估平台本身，不用于评价学生");
      assert.deepEqual(report.metrics.map((metric) => metric.key), ALL_METRICS);
      for (const metric of report.metrics) {
        assert.deepEqual(Object.keys(metric).sort(), METRIC_KEYS, metric.key);
        assert.match(metric.definition, /[一-鿿]/, `${metric.key} has a definition`);
      }
      const m = byKey(report);
      const ratio = (key, value, numerator, denominator) => {
        assert.deepEqual([m[key].value, m[key].numerator, m[key].denominator, m[key].sampleSize], [value, numerator, denominator, denominator], key);
        assert.equal(m[key].reason, null, key);
      };
      const dist = (key, medianValue, p90Value, n) => {
        assert.deepEqual([m[key].median, m[key].p90, m[key].sampleSize, m[key].value], [medianValue, p90Value, n, null], key);
      };
      // T1, T2, T3, T4 confirmed in October; T1 (accepted) and T3 (rejected) have a final review. T6 is out of period.
      ratio("closed_loop_completion", 0.5, 2, 4);
      // Guidance 10-02 00:00 → cr_pm1 opened 10-02 05:40.
      dist("guidance_to_first_pr", 340, 340, 1);
      // T1 220 min, T3 90 min, T2 335 min (published_at kept after merge); legacy T4 (webhook-touched) is not
      // recoverable; T6 opened before the period.
      dist("confirmation_to_first_pr", 220, 335, 3);
      assert.match(m.confirmation_to_first_pr.caveat, /有 1 个/);
      // cr_pm1 120, cr_pm5 60, cr_pm3 180 min.
      dist("change_review_time", 120, 180, 3);
      dist("run_queue_time", 20, 40, 7);
      dist("run_execution_time", 60, 60, 7);
      // Plan-first att_pm4 is excluded from queue/run time.
      dist("attempt_queue_time", 10, 20, 4);
      dist("attempt_execution_time", 30, 30, 4);
      // att_pm1 1200, att_pm2 4000, att_pm3 600, att_pm4 2000 (att_pm5 reported nothing; att_pm6 ended in September).
      dist("tokens_per_attempt", 1600, 4000, 4);
      dist("tokens_per_task", 2000, 4600, 3);
      dist("agent_wall_minutes_per_attempt", 25, 30, 3);
      // run_pm3 recovered by run_pm4; run_pm7 not recovered.
      ratio("run_failure_recovery", 0.5, 1, 2);
      ratio("attempt_failure_recovery", 1, 1, 1);
      // run_pm8 repeats run_pm7's scheduler job on the same runner; run_pm9 uses another runner.
      assert.deepEqual([m.duplicate_jobs.value, m.duplicate_jobs.sampleSize], [1, 9]);
      // run_pm2 reproduces run_pm1 (|Δacc| 0.005 ≤ 0.01); run_pm6 does not (0.005 > task tolerance 0.001).
      ratio("reproduction_ratio", 0.5, 1, 2);
      const lookup = m.mentor_evidence_lookup_time;
      assert.deepEqual([lookup.computable, lookup.value, lookup.median, lookup.sampleSize], [false, null, null, 0]);
      assert.match(lookup.reason, /埋点/);
      assert.ok(report.metrics.filter((metric) => metric.key !== "mentor_evidence_lookup_time").every((metric) => metric.computable));
    });

    await t.test("no per-student or per-person fields in the payload", async () => {
      const report = await get(period, "root");
      const text = JSON.stringify(report);
      for (const forbidden of ["pm-a", "pm-b", "试点甲", "试点乙", "试点导师", "3101", "3102", "3103", "task_pm", "run_pm", "att_pm", "cr_pm", "job-1"]) {
        assert.ok(!text.includes(forbidden), `payload must not contain ${forbidden}`);
      }
      for (const key of collectKeys(report)) assert.doesNotMatch(key, /student|user|actor|name|person|rank|task|run_id/i, key);
    });

    await t.test("an empty period returns null values with a reason, never zeros", async () => {
      const report = await get({ from: "2025-01-01", to: "2025-01-31" }, "root");
      for (const metric of report.metrics) {
        assert.equal(metric.sampleSize, 0, metric.key);
        if (metric.kind === "count") { assert.equal(metric.value, 0); continue; }
        assert.equal(metric.value, null, metric.key);
        assert.equal(metric.median, null, metric.key);
        assert.equal(typeof metric.reason, "string", metric.key);
      }
      assert.equal(byKey(report).reproduction_ratio.reason, "周期内没有同一运行规格的重复执行");
    });

    await t.test("default period is accepted", async () => {
      const report = await get(null, "root");
      assert.equal(report.metrics.length, ALL_METRICS.length);
    });

    assert.equal(state.outbound, 0);
  } finally {
    await mf.dispose();
  }
});
