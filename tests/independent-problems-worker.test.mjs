import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";

// Use the compiled Worker with isolated in-memory D1/R2. No production records,
// credentials or external notification endpoints are used by this fixture.
test("unresolved problems survive new progress and remain actionable independently of next-action history", { timeout: 120_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")]
      .map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "independent-problems-test" },
    r2Buckets: ["FILES"],
  });
  const origin = "http://localhost";
  const cookie = (actor) => `tanyan_session=independent-${actor}; tanyan_persona=${actor === "mentor" ? "management" : "student"}`;
  const get = (path, actor = "mentor") => mf.dispatchFetch(origin + path, { headers: { cookie: cookie(actor) } });
  const json = (path, body, actor, method = "POST", headers = {}) => mf.dispatchFetch(origin + path, {
    method,
    headers: { "content-type": "application/json", origin, cookie: cookie(actor), ...headers },
    body: JSON.stringify(body),
  });
  const expectJson = async (response, status = 200) => {
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  const result = async (entryId, itemKind, expectedVersion, requestId, note, actor = "student") => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ progressEntryId: entryId, revisionNumber: 1,
      itemKind, expectedVersion, requestId, note })) form.set(key, String(value));
    // Serialize native FormData first: Miniflare's fetch implementation uses a
    // separate undici realm and does not recognize Node's FormData instance.
    const request = new Request(origin + "/api/progress-resolutions", {
      method: "POST", headers: { origin, cookie: cookie(actor) }, body: form,
    });
    return mf.dispatchFetch(request.url, {
      method: "POST", headers: Object.fromEntries(request.headers), body: await request.arrayBuffer(),
    });
  };
  const readProblems = async () => (await expectJson(await get("/api/problem-records"))).records;
  const readItems = async () => (await expectJson(await get("/api/progress-resolutions?studentId=independent-student", "student"))).items;
  const readOverview = async () => (await expectJson(await get("/api/dashboard/overview"))).students
    .find((student) => student.studentId === "independent-student");
  const readWorkflowTasks = async () => (await expectJson(await get("/api/dashboard?studentId=independent-student"))).workflowTasks;
  const submitProgress = async (requestId, title, blocker = "") => expectJson(await json("/api/progress", {
    studentId: "independent-student", kind: "项目", title,
    summary: "本次已完成新的测量与整理，可以继续开展下一批工作。",
    evidence: "已整理 12 组测试结果与对照记录。",
    nextAction: "完成下一批实验", nextActionDueDate: "2099-12-31", blocker,
  }, "student", "POST", { "Idempotency-Key": requestId }), 201);
  const confirmProgress = async (entryId) => expectJson(await json("/api/reviews", {
    id: entryId, action: "substantive", note: "本次提交的实验结果已经核验。",
  }, "mentor"));

  try {
    await mf.dispatchFetch(origin + "/api/health/ready");
    const db = await mf.getD1Database("DB");
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('independent-student', '独立问题测试学生', '硕士', 2025, '实验', 1),
      ('independent-other', '权限测试学生', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (701, 'independent-student-user', '独立问题测试学生', 'student', 'independent-student'),
      (702, 'independent-mentor-user', '独立问题测试导师', 'superadmin', NULL),
      (703, 'independent-other-user', '权限测试学生', 'student', 'independent-other')`).run();
    for (const [id, actor] of [[701, "student"], [702, "mentor"], [703, "other"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`independent-${actor}`), id).run();
    }

    const first = await submitProgress("independent_first_progress", "第一批测量完成", "高精度探头仍在维修，后续精度比较待解决。");
    await confirmProgress(first.id);
    // Store an actual next-action result before superseding this progress. It
    // must remain a history record, while the problem follows its own lifecycle.
    await expectJson(await result(first.id, "next_action", 0, "independent_next_action", "已完成这一轮实验的后续整理。"));
    let next;

    await t.test("an open problem does not prevent the next student submission or its review", async () => {
      const before = (await readProblems()).find((record) => record.id === `progress:${first.id}:1:blocker`);
      assert.equal(before?.status, "open");
      next = await submitProgress("independent_second_progress", "第二批测量完成");
      assert.notEqual(next.id, first.id);
      assert.equal((await readProblems()).find((record) => record.id === before.id)?.status, "open");
      const submittedOverview = await readOverview();
      assert.equal(submittedOverview?.primaryState, "mentor", "submitted progress still requires mentor confirmation");
      assert.ok(submittedOverview.counters.blocked >= 1, "independent unresolved problems remain visible beside progress status");
      await confirmProgress(next.id);
      const after = (await readProblems()).find((record) => record.id === before.id);
      assert.equal(after?.status, "open", "reviewing new progress must not close or archive an unresolved problem");
      assert.equal(after?.current, true);
      assert.equal(after?.content, before.content);
      const confirmedOverview = await readOverview();
      assert.equal(confirmedOverview?.primaryState, "on_track", "confirmed current progress remains normal despite an unresolved earlier problem");
      assert.ok(confirmedOverview.counters.blocked >= 1);
      const entry = await db.prepare("SELECT review_status, assessment FROM progress_entries WHERE id = ?").bind(next.id).first();
      assert.deepEqual(entry, { review_status: "accepted", assessment: "substantive" });
      const items = await readItems();
      const blocker = items.find((item) => item.progressEntryId === first.id && item.itemKind === "blocker");
      assert.equal(blocker?.current, true);
      assert.equal(blocker?.status, "open");
      assert.equal(blocker?.version, 0);
    });

    await t.test("the same superseded progress keeps next-action mutation guards", async () => {
      const historical = (await readItems()).find((item) => item.progressEntryId === first.id && item.itemKind === "next_action");
      assert.equal(historical?.current, false);
      assert.equal(historical?.status, "pending");
      assert.equal(historical?.version, 1);
      const confirmation = await json("/api/progress-resolutions", {
        progressEntryId: first.id, revisionNumber: 1, itemKind: "next_action", expectedVersion: 1,
        action: "confirm", requestId: "independent_stale_next_confirm", note: "不能把旧计划当成当前计划处理。",
      }, "mentor", "PATCH");
      assert.equal(confirmation.status, 409, await confirmation.text());
      const staleSubmission = await result(first.id, "next_action", 1, "independent_stale_next_submit", "旧计划不能继续写入。");
      assert.equal(staleSubmission.status, 409, await staleSubmission.text());
      const current = (await readItems()).find((item) => item.progressEntryId === next.id && item.itemKind === "next_action");
      assert.equal(current?.current, true);
      assert.equal(current?.status, "open");
      assert.ok(!(await readWorkflowTasks()).some((task) => task.type === "resolution_verification"),
        "superseded pending next actions must not remain in the mentor verification inbox");
    });

    await t.test("the original problem accepts a result and mentor confirmation after newer progress", async () => {
      const unauthorized = await result(first.id, "blocker", 0, "independent_other_cannot_submit", "不属于本人的问题。", "other");
      assert.equal(unauthorized.status, 403, await unauthorized.text());
      await expectJson(await result(first.id, "blocker", 0, "independent_problem_result", "探头已修复，已完成校准并复核精度。"));
      let record = (await readProblems()).find((item) => item.id === `progress:${first.id}:1:blocker`);
      assert.equal(record?.status, "pending");
      const storedProblem = await db.prepare(`SELECT id, revision_number FROM progress_resolutions
        WHERE progress_entry_id = ? AND item_kind = 'blocker'`).bind(first.id).first();
      const verificationTasks = (await readWorkflowTasks()).filter((task) => task.type === "resolution_verification");
      assert.equal(verificationTasks.length, 1, "only the independently pending problem belongs in the mentor verification inbox");
      assert.equal(verificationTasks[0].id, storedProblem.id);
      assert.equal(verificationTasks[0].progressEntryId, first.id);
      assert.equal(verificationTasks[0].revisionNumber, storedProblem.revision_number);
      assert.equal(verificationTasks[0].itemKind, "blocker");
      const otherDashboard = await expectJson(await get("/api/dashboard?studentId=independent-other"));
      assert.deepEqual(otherDashboard.workflowTasks, [], "student-filtered dashboards must not leak another student's unresolved problems");
      const confirmation = {
        progressEntryId: first.id, revisionNumber: 1, itemKind: "blocker", expectedVersion: 1,
        action: "confirm", requestId: "independent_problem_confirm", note: "已核验维修记录与校准结果。",
      };
      await expectJson(await json("/api/progress-resolutions", confirmation, "mentor", "PATCH"));
      // Retrying the same saved request must not create a second confirmation.
      await expectJson(await json("/api/progress-resolutions", confirmation, "mentor", "PATCH"));
      record = (await readProblems()).find((item) => item.id === `progress:${first.id}:1:blocker`);
      assert.equal(record?.status, "resolved");
      const item = (await readItems()).find((value) => value.progressEntryId === first.id && value.itemKind === "blocker");
      assert.equal(item?.version, 2);
      assert.equal(item?.submissionNote, "探头已修复，已完成校准并复核精度。");
      assert.equal(item?.reviewerNote, "已核验维修记录与校准结果。");
      assert.deepEqual(item.history.map((event) => event.action).sort(), ["confirm", "submit"]);
      assert.ok(!(await readWorkflowTasks()).some((task) => task.type === "resolution_verification"),
        "confirmed problem results leave the mentor verification inbox");
      const newerProgress = await db.prepare("SELECT review_status, assessment FROM progress_entries WHERE id = ?").bind(next.id).first();
      assert.deepEqual(newerProgress, { review_status: "accepted", assessment: "substantive" });
    });
  } finally {
    await mf.dispose();
  }
});
