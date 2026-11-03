import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { parseEvidencePeriod } from "../lib/research-loop-evidence.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Weekly-meeting evidence list (frontend plan FA4) against the built Worker.
// Every fixture is synthetic and outbound network is blocked. Timestamps are
// stored the way the services write them: CURRENT_TIMESTAMP ("YYYY-MM-DD
// HH:MM:SS", UTC) or ISO strings. Asia/Shanghai is UTC+8, so the Shanghai day
// 2026-10-26 starts at "2026-10-25 16:00:00" UTC.
const EVAL = "e".repeat(64);
const IMAGE = `registry.lab/train@sha256:${"c".repeat(64)}`;
const SHA = "1".repeat(40);
const REPORT_KEYS = ["blockers", "changeRequests", "period", "runs", "studentId", "tasks"];
const TASK_KEYS = ["created", "status", "taskId", "title", "versionsConfirmed"];
const CR_KEYS = ["createdAt", "id", "prNumber", "prUrl", "status", "taskId"];
const RUN_KEYS = ["endedAt", "failureReason", "interpreted", "metrics", "number", "reviewState", "runId", "status", "taskId", "technicalValidity"];
const BLOCKER_KEYS = ["kind", "runId", "taskId", "text"];

async function startWorker() {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const state = { outbound: 0 };
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "evidence-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { state.outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  return { mf, state };
}

const personas = { studentA: "student", studentB: "student" };
function caller(mf) {
  return async (query, actor, expected = 200) => {
    const cookie = actor ? `tanyan_session=ev-${actor}; tanyan_persona=${personas[actor] ?? "management"}` : "";
    const response = await mf.dispatchFetch(`http://localhost/api/research-loop/evidence?${new URLSearchParams(query)}`, { headers: { cookie } });
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
    ('ev-a', '证据甲', '博士', 2025, '实验', 1), ('ev-b', '证据乙', '硕士', 2025, '实验', 1), ('ev-off', '已停用', '硕士', 2025, '实验', 0)`).run();
  await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
    (2101, 'ev-student-a', '证据甲', 'student', 'ev-a'), (2102, 'ev-student-b', '证据乙', 'student', 'ev-b'),
    (2103, 'ev-mentor-1', '导师一', 'mentor', NULL), (2104, 'ev-mentor-2', '范围外导师', 'mentor', NULL),
    (2105, 'ev-root', '超级管理员', 'superadmin', NULL), (2106, 'ev-mentor-3', '只读导师', 'mentor', NULL)`).run();
  await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
    (2103, 'ev-a', 1, 1), (2103, 'ev-off', 1, 1), (2104, 'ev-b', 1, 1), (2104, 'ev-a', 1, 0), (2106, 'ev-a', 0, 1)`).run();
  for (const [id, actor] of [[2101, "studentA"], [2102, "studentB"], [2103, "mentor1"], [2104, "mentor2"], [2105, "root"], [2106, "mentor3"]]) {
    await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
      .bind(digest(`ev-${actor}`), id).run();
  }
  await db.prepare(`INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES
    ('rnr_ev_agent', '代理', 'agent', ?), ('rnr_ev_gpu', 'GPU', 'compute', ?)`).bind("8".repeat(64), "7".repeat(64)).run();
  await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES
    ('cred_ev_a', 2101, 'codex', 'rnr_ev_agent'), ('cred_ev_b', 2102, 'codex', 'rnr_ev_agent')`).run();
  await db.prepare(`INSERT INTO registered_entrypoints(id, github_repository_id, name, argv_json, image_ref, evaluation_protocol_sha256, created_by_user_id)
    VALUES ('ep_ev', 7001, 'train', '["python","train.py"]', ?, ?, 2105)`).bind(IMAGE, EVAL).run();
  await db.prepare(`INSERT INTO dataset_versions(id, label, runner_id, manifest_sha256, egress_policy_json, created_by_user_id)
    VALUES ('ds_ev', '合成数据', 'rnr_ev_gpu', ?, '{}', 2105)`).bind("a".repeat(64)).run();

  const task = (id, studentId, title, status, createdAt, updatedAt) => db.prepare(`INSERT INTO research_tasks
    (id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)`)
    .bind(id, studentId, title, status, studentId === "ev-a" ? 2101 : 2102, `c-${id}`, `m-${id}`, createdAt, updatedAt).run();
  const version = (taskId, number, createdAt, confirmedAt) => db.prepare(`INSERT INTO research_task_versions
    (task_id, version, title, research_question, instructions, acceptance_criteria, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at, created_at)
    VALUES (?, ?, '合成任务', '合成问题', '合成说明', '合成标准', ?, 2101, ?, ?, ?)`)
    .bind(taskId, number, "d".repeat(64), confirmedAt ? 2103 : null, confirmedAt, createdAt).run();
  const event = (taskId, number, action, createdAt) => db.prepare(`INSERT INTO research_task_events
    (task_id, version, action, actor_type, actor_user_id, created_at) VALUES (?, ?, ?, 'user', 2101, ?)`)
    .bind(taskId, number, action, createdAt).run();

  // T1: created one second before the period (Shanghai 10-25 23:59:59); v2 revised at
  // Shanghai midnight and confirmed inside the period (ISO timestamp).
  await task("task_ev1", "ev-a", "边界任务", "confirmed", "2026-10-25 15:59:59", "2026-10-26 01:00:00");
  await version("task_ev1", 1, "2026-10-25 15:59:59", "2026-10-25 15:59:59");
  await version("task_ev1", 2, "2026-10-25 16:00:00", "2026-10-26T01:00:00.000Z");
  await event("task_ev1", 1, "created", "2026-10-25 15:59:59");
  await event("task_ev1", 1, "confirmed", "2026-10-25 15:59:59");
  await event("task_ev1", 2, "revised", "2026-10-25 16:00:00");
  await event("task_ev1", 2, "confirmed", "2026-10-26T01:00:00.000Z");
  // T2: draft created exactly at the period's first Shanghai midnight, never confirmed.
  await task("task_ev2", "ev-a", "草稿任务", "draft", "2026-10-25 16:00:00", "2026-10-25 16:00:00");
  await version("task_ev2", 1, "2026-10-25 16:00:00", null);
  await event("task_ev2", 1, "created", "2026-10-25 16:00:00");
  // T3: old confirmed task, only runs at the period edges.
  await task("task_ev3", "ev-a", "运行边界任务", "confirmed", "2026-09-01 00:00:00", "2026-09-02 00:00:00");
  await version("task_ev3", 1, "2026-09-01 00:00:00", "2026-09-02 00:00:00");
  // T4: draft created on Shanghai 10-29: exactly 3 days at period end, not a blocker yet.
  await task("task_ev4", "ev-a", "新草稿", "draft", "2026-10-29 01:00:00", "2026-10-29 01:00:00");
  await version("task_ev4", 1, "2026-10-29 01:00:00", null);
  await event("task_ev4", 1, "created", "2026-10-29 01:00:00");
  // T5: canceled before the period; its failed run is not a blocker.
  await task("task_ev5", "ev-a", "已取消任务", "canceled", "2026-09-01 00:00:00", "2026-09-10 00:00:00");
  await version("task_ev5", 1, "2026-09-01 00:00:00", null);
  await event("task_ev5", 1, "canceled", "2026-09-10 00:00:00");
  // T6: change requests.
  await task("task_ev6", "ev-a", "变更任务", "confirmed", "2026-09-01 00:00:00", "2026-09-02 00:00:00");
  await version("task_ev6", 1, "2026-09-01 00:00:00", "2026-09-02 00:00:00");
  // Other student: activity in the same period must never leak.
  await task("task_evb", "ev-b", "乙的任务", "draft", "2026-10-27 00:00:00", "2026-10-27 00:00:00");
  await version("task_evb", 1, "2026-10-20 00:00:00", null);

  let attempt = 0;
  const changeRequest = async (id, taskId, studentId, status, prNumber, createdAt, updatedAt) => {
    const attemptId = `att_ev_${++attempt}`;
    await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
      base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
      VALUES (?, ?, 1, ?, 'codex', ?, 7001, ?, ?, 'change_ready', ?, ?)`)
      .bind(attemptId, taskId, studentId, studentId === "ev-a" ? "cred_ev_a" : "cred_ev_b", "0".repeat(40), "d".repeat(64), `idem-${attemptId}`,
        studentId === "ev-a" ? 2101 : 2102).run();
    await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name,
      head_commit_sha, pr_number, pr_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, 7001, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, taskId, attemptId, studentId, "0".repeat(40), `tanyan/${id}`, SHA, prNumber,
        prNumber ? `https://github.com/synthetic-lab/a/pull/${prNumber}` : "", status, createdAt, updatedAt).run();
  };
  await changeRequest("cr_old_fail", "task_ev6", "ev-a", "failed", null, "2026-10-01 00:00:00", "2026-10-02 00:00:00");
  await changeRequest("cr_open", "task_ev6", "ev-a", "open", 7, "2026-10-03 00:00:00", "2026-10-03 00:00:00");
  await changeRequest("cr_edge", "task_ev6", "ev-a", "merged", 6, "2026-10-25 15:59:59", "2026-10-26 00:00:00");
  await changeRequest("cr_in", "task_ev6", "ev-a", "open", 8, "2026-10-25 16:00:00", "2026-10-25 16:00:00");
  await changeRequest("cr_rej", "task_ev6", "ev-a", "rejected", null, "2026-10-27 02:00:00", "2026-10-28 00:00:00");
  await changeRequest("cr_b", "task_evb", "ev-b", "rejected", 9, "2026-10-27 02:00:00", "2026-10-28 00:00:00");

  let spec = 0;
  const run = async (id, taskId, studentId, status, createdAt, endedAt, failureReason = "") => {
    const sha = (++spec).toString(16).padStart(64, "0");
    await db.prepare(`INSERT INTO run_specs(sha256, canonical_json, task_id, task_version, student_id, github_repository_id, executed_commit_sha,
      entrypoint_id, dataset_version_id, created_by_user_id) VALUES (?, '{}', ?, 1, ?, 7001, ?, 'ep_ev', 'ds_ev', 2105)`)
      .bind(sha, taskId, studentId, SHA).run();
    await db.prepare(`INSERT INTO runs(id, run_spec_sha256, task_id, student_id, status, idempotency_key, submit_tag, failure_reason,
      created_by_user_id, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2105, ?, ?)`)
      .bind(id, sha, taskId, studentId, status, `idem-${id}`, `tanyan-${id}`, failureReason, createdAt, endedAt).run();
  };
  // T1 runs (#1–#5): a failure cleared by a newer success, a later failure that stays open,
  // one in flight, one created after the period.
  await run("run_f1", "task_ev1", "ev-a", "failed", "2026-10-26 01:00:00", "2026-10-26 02:00:00", "显存不足");
  await run("run_c2", "task_ev1", "ev-a", "completed", "2026-10-26 03:00:00", "2026-10-27T03:00:00.000Z");
  await run("run_f3", "task_ev1", "ev-a", "failed", "2026-10-28 00:00:00", "2026-10-29 08:00:00", "调度器拒绝作业");
  await run("run_q4", "task_ev1", "ev-a", "running", "2026-10-30 09:00:00", null);
  await run("run_late", "task_ev1", "ev-a", "queued", "2026-11-01 16:00:00", null);
  // T3 runs (#1–#3) at the Shanghai midnight edges.
  await run("run_early", "task_ev3", "ev-a", "failed", "2026-10-20 00:00:00", "2026-10-25 15:59:59", "数据读取失败");
  await run("run_in", "task_ev3", "ev-a", "completed", "2026-10-30 00:00:00", "2026-11-01 15:59:59");
  await run("run_out", "task_ev3", "ev-a", "completed", "2026-10-31 00:00:00", "2026-11-01 16:00:00");
  await run("run_t5", "task_ev5", "ev-a", "failed", "2026-09-04 00:00:00", "2026-09-05 00:00:00", "旧失败");
  await run("run_b", "task_evb", "ev-b", "failed", "2026-10-27 00:00:00", "2026-10-28 00:00:00", "乙的失败");

  const metrics = JSON.stringify({ evaluationProtocolSha256: EVAL, schema: "tanyan.metrics/v1", split: "test", values: { acc: 0.91, loss: 0.2 } });
  await db.prepare(`INSERT INTO run_results(run_id, manifest_sha256, manifest_json, metrics_json, technical_validity) VALUES
    ('run_c2', ?, '{}', ?, 'valid'), ('run_in', ?, '{}', NULL, 'invalid'), ('run_f1', ?, '{}', NULL, 'invalid')`)
    .bind("9".repeat(64), metrics, "9".repeat(64), "9".repeat(64)).run();
  await db.prepare(`INSERT INTO result_reviews(run_id, state, reviewer_user_id) VALUES ('run_c2', 'accepted', 2103), ('run_in', 'pending', NULL)`).run();
  await db.prepare(`INSERT INTO result_interpretations(run_id, version, author_user_id, what_it_shows, request_id) VALUES
    ('run_c2', 1, 2101, '准确率提升', 'interp-c2'), ('run_c2', 2, 2101, '准确率提升（修订）', 'interp-c2-2')`).run();
}

function assertShape(report) {
  assert.deepEqual(Object.keys(report).sort(), REPORT_KEYS);
  assert.deepEqual(Object.keys(report.period).sort(), ["from", "to"]);
  for (const item of report.tasks) assert.deepEqual(Object.keys(item).sort(), TASK_KEYS);
  for (const item of report.changeRequests) assert.deepEqual(Object.keys(item).sort(), CR_KEYS);
  for (const item of report.runs) assert.deepEqual(Object.keys(item).sort(), RUN_KEYS);
  for (const item of report.blockers) assert.deepEqual(Object.keys(item).sort(), BLOCKER_KEYS);
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /[0-9a-f]{40}/i, "no full SHAs or sha256 values");
  assert.doesNotMatch(text, /canonical_json|manifest|what_it_shows|准确率提升|token/i, "no file contents or secrets");
}

test("research loop evidence report: period, sections, blockers and scope", { timeout: 240_000 }, async (t) => {
  const { mf, state } = await startWorker();
  const get = caller(mf);
  try {
    const db = await applyD1Migrations(mf);
    await seed(db);
    const week = { studentId: "ev-a", from: "2026-10-26", to: "2026-11-01" };

    await t.test("each section is populated from the seeded rows in deterministic order", async () => {
      const report = await get(week, "studentA");
      assertShape(report);
      assert.equal(report.studentId, "ev-a");
      assert.deepEqual(report.period, { from: "2026-10-26", to: "2026-11-01" });

      assert.deepEqual(report.tasks, [
        { taskId: "task_ev3", title: "运行边界任务", status: "confirmed", versionsConfirmed: 0, created: false },
        { taskId: "task_ev6", title: "变更任务", status: "confirmed", versionsConfirmed: 0, created: false },
        { taskId: "task_ev1", title: "边界任务", status: "confirmed", versionsConfirmed: 1, created: false },
        { taskId: "task_ev2", title: "草稿任务", status: "draft", versionsConfirmed: 0, created: true },
        { taskId: "task_ev4", title: "新草稿", status: "draft", versionsConfirmed: 0, created: true },
      ]);

      assert.deepEqual(report.changeRequests, [
        { id: "cr_in", taskId: "task_ev6", prNumber: 8, prUrl: "https://github.com/synthetic-lab/a/pull/8", status: "open", createdAt: "2026-10-25T16:00:00.000Z" },
        { id: "cr_rej", taskId: "task_ev6", prNumber: null, prUrl: "", status: "rejected", createdAt: "2026-10-27T02:00:00.000Z" },
      ]);

      assert.deepEqual(report.runs.map((run) => [run.runId, run.number, run.status]), [
        ["run_f1", 1, "failed"], ["run_c2", 2, "completed"], ["run_f3", 3, "failed"], ["run_in", 2, "completed"], ["run_q4", 4, "running"],
      ]);
      const c2 = report.runs.find((run) => run.runId === "run_c2");
      assert.deepEqual(c2, {
        runId: "run_c2", taskId: "task_ev1", number: 2, status: "completed", technicalValidity: "valid", reviewState: "accepted",
        endedAt: "2026-10-27T03:00:00.000Z", metrics: { acc: 0.91, loss: 0.2 }, failureReason: "", interpreted: true,
      });
      const f1 = report.runs.find((run) => run.runId === "run_f1");
      assert.equal(f1.failureReason, "显存不足");
      assert.equal(f1.technicalValidity, "invalid");
      assert.equal(f1.reviewState, null);
      assert.equal(f1.interpreted, false);
      assert.equal(f1.metrics, null);
      const q4 = report.runs.find((run) => run.runId === "run_q4");
      assert.equal(q4.endedAt, null);
      assert.equal(q4.technicalValidity, null);
      const runIn = report.runs.find((run) => run.runId === "run_in");
      assert.equal(runIn.reviewState, "pending");
      assert.equal(runIn.endedAt, "2026-11-01T15:59:59.000Z");

      // Same request twice → identical output.
      assert.deepEqual(await get(week, "mentor1"), report);
      assert.deepEqual(await get(week, "mentor3"), report, "read-only mentor in scope may view");
      assert.deepEqual(await get(week, "root"), report);
    });

    await t.test("blockers: open failures, rejected changes, stale drafts; a newer success clears an older failure", async () => {
      const report = await get(week, "studentA");
      assert.deepEqual(report.blockers.map((item) => [item.kind, item.taskId, item.runId]), [
        ["task_unconfirmed", "task_ev2", null],
        ["change_failed", "task_ev6", null],
        ["run_failed", "task_ev1", "run_f3"],
      ]);
      const [draft, change, failed] = report.blockers;
      assert.match(draft.text, /草稿任务/);
      assert.match(draft.text, /6 天未确认/);
      assert.match(change.text, /变更任务/);
      assert.match(change.text, /退回/);
      assert.match(failed.text, /运行 #3/);
      assert.match(failed.text, /调度器拒绝作业/);
      // Not blockers: run_f1 (cleared by run_c2), run_early (cleared by run_in), cr_old_fail
      // (cleared by cr_open), task_ev4 (exactly 3 days), the canceled task's failed run.
      const ids = JSON.stringify(report.blockers);
      for (const id of ["run_f1", "run_early", "run_t5", "task_ev4", "task_ev5"]) assert.ok(!ids.includes(id), id);

      // As of an earlier period end, run_in had not ended yet, so run_early is still open.
      const earlier = await get({ studentId: "ev-a", from: "2026-10-25", to: "2026-10-31" }, "mentor1");
      assert.deepEqual(earlier.blockers.map((item) => [item.kind, item.runId ?? item.taskId]), [
        ["run_failed", "run_early"], ["task_unconfirmed", "task_ev2"], ["change_failed", "task_ev6"], ["run_failed", "run_f3"],
      ]);
      assert.match(earlier.blockers[1].text, /5 天未确认/);
      assert.ok(earlier.runs.some((run) => run.runId === "run_early"), "run_early ended on Shanghai 10-25 23:59:59");
      assert.ok(!earlier.runs.some((run) => run.runId === "run_in"));

      // A period before the success of run_c2 keeps run_f1 open.
      const before = await get({ studentId: "ev-a", from: "2026-10-26", to: "2026-10-26" }, "mentor1");
      assert.ok(before.blockers.some((item) => item.runId === "run_f1"));
      assert.ok(!before.blockers.some((item) => item.kind === "task_unconfirmed"), "draft is 0 days old");
    });

    await t.test("Shanghai midnight bounds", async () => {
      const lastDay = await get({ studentId: "ev-a", from: "2026-11-01", to: "2026-11-01" }, "studentA");
      assert.deepEqual(lastDay.runs.map((run) => run.runId), ["run_in", "run_q4"], "ended 23:59:59 included; created at next midnight excluded");
      const nextDay = await get({ studentId: "ev-a", from: "2026-11-02", to: "2026-11-02" }, "studentA");
      assert.deepEqual(nextDay.runs.map((run) => run.runId), ["run_out", "run_q4", "run_late"]);
      assert.deepEqual(nextDay.tasks.map((task) => task.taskId), ["task_ev3", "task_ev1"]);
      assert.deepEqual(nextDay.changeRequests, []);

      const firstDay = await get({ studentId: "ev-a", from: "2026-10-26", to: "2026-10-26" }, "studentA");
      assert.deepEqual(firstDay.changeRequests.map((cr) => cr.id), ["cr_in"], "created at 00:00:00 included, 23:59:59 the day before excluded");
      assert.deepEqual(firstDay.tasks.map((task) => [task.taskId, task.created, task.versionsConfirmed]), [
        ["task_ev6", false, 0], ["task_ev1", false, 1], ["task_ev2", true, 0],
      ]);
      const dayBefore = await get({ studentId: "ev-a", from: "2026-10-25", to: "2026-10-25" }, "studentA");
      assert.deepEqual(dayBefore.tasks.map((task) => [task.taskId, task.created, task.versionsConfirmed]), [
        ["task_ev3", false, 0], ["task_ev6", false, 0], ["task_ev1", true, 1],
      ]);
      assert.deepEqual(dayBefore.changeRequests.map((cr) => cr.id), ["cr_edge"]);
      assert.deepEqual(dayBefore.runs.map((run) => run.runId), ["run_early"], "in-flight runs created later are not listed");
    });

    await t.test("scope isolation", async () => {
      const own = await get(week, "studentA");
      assert.ok(!JSON.stringify(own).match(/ev-b|task_evb|cr_b|run_b|乙/), "other student's rows never leak");
      await get(week, "studentB", 403);
      await get(week, "mentor2", 403);
      await get(week, null, 401);
      const other = await get({ ...week, studentId: "ev-b" }, "studentB");
      assert.deepEqual(other.runs.map((run) => run.runId), ["run_b"]);
      assert.deepEqual(other.changeRequests.map((cr) => cr.id), ["cr_b"]);
      await get({ ...week, studentId: "ev-b" }, "studentA", 403);
      await get({ ...week, studentId: "ev-b" }, "mentor1", 403);
      await get({ ...week, studentId: "ev-off" }, "mentor1", 404);
      await get({ ...week, studentId: "ev-missing" }, "root", 404);
    });

    await t.test("invalid periods and inputs are rejected", async () => {
      for (const query of [
        { studentId: "ev-a", from: "2026-11-02", to: "2026-11-01" },
        { studentId: "ev-a", from: "2026-09-01", to: "2026-11-02" },
        { studentId: "ev-a", from: "2026-13-01", to: "2026-11-01" },
        { studentId: "ev-a", from: "2026-02-30", to: "2026-03-01" },
        { studentId: "ev-a", from: "20261026", to: "2026-11-01" },
        { studentId: "ev-a", from: "2026/10/26", to: "2026-11-01" },
        { studentId: "ev-a", from: "2026-10-26", to: "2026-11-01T00:00" },
        { studentId: "", from: "2026-10-26", to: "2026-11-01" },
        { studentId: "../ev-a", from: "2026-10-26", to: "2026-11-01" },
      ]) {
        const body = await get(query, "studentA", 400);
        assert.equal(body.code, "INVALID_INPUT");
      }
      assert.match((await get({ studentId: "ev-a", from: "2026-11-02", to: "2026-11-01" }, "studentA", 400)).error, /开始日期不能晚于结束日期/);
      assert.match((await get({ studentId: "ev-a", from: "2026-09-01", to: "2026-11-02" }, "studentA", 400)).error, /62 天/);
      // Exactly 62 days is allowed.
      const longest = await get({ studentId: "ev-a", from: "2026-09-01", to: "2026-11-01" }, "studentA");
      assert.deepEqual(longest.period, { from: "2026-09-01", to: "2026-11-01" });
    });

    await t.test("defaults to the last 7 Shanghai days", async () => {
      const report = await get({ studentId: "ev-a" }, "studentA");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      assert.equal(report.period.to, today);
      const span = (Date.parse(`${report.period.to}T00:00:00Z`) - Date.parse(`${report.period.from}T00:00:00Z`)) / 86_400_000;
      assert.equal(span, 6);
    });

    assert.equal(state.outbound, 0, "no outbound network");
  } finally {
    await mf.dispose();
  }
});

test("evidence period parsing uses Shanghai calendar days", () => {
  // 2026-11-02 23:30 Shanghai is 15:30 UTC the same day; 00:30 Shanghai is the previous UTC day.
  assert.deepEqual(parseEvidencePeriod(null, null, "2026-11-02T15:30:00Z"), {
    from: "2026-10-27", to: "2026-11-02",
    start: Date.parse("2026-10-26T16:00:00Z"), end: Date.parse("2026-11-02T16:00:00Z"),
  });
  assert.equal(parseEvidencePeriod(null, null, "2026-11-01T16:30:00Z").to, "2026-11-02");
  assert.deepEqual(parseEvidencePeriod(null, "2026-03-01", "2026-11-02T00:00:00Z").from, "2026-02-23");
  assert.equal(parseEvidencePeriod("2026-11-01", null, "2026-11-02T00:00:00Z").to, "2026-11-02");
  assert.throws(() => parseEvidencePeriod("2026-11-03", "2026-11-02"), /开始日期不能晚于结束日期/);
  assert.throws(() => parseEvidencePeriod("2026-01-01", "2026-03-04"), /62 天/);
  assert.doesNotThrow(() => parseEvidencePeriod("2026-01-01", "2026-03-03"));
});
