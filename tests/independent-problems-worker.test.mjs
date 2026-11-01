import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

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
  const readDashboard = async () => expectJson(await get("/api/dashboard?studentId=independent-student"));
  const readMonthlyDelivery = async () => {
    const [mentorDashboard, studentDashboard] = await Promise.all([
      readDashboard(),
      expectJson(await get("/api/dashboard?studentId=independent-student", "student")),
    ]);
    const mentorSummary = mentorDashboard.students.find((student) => student.id === "independent-student")?.monthlyDelivery;
    assert.ok(mentorSummary, "the management dashboard must expose monthly delivery counts");
    assert.deepEqual(studentDashboard.students.map((student) => student.id), ["independent-student"]);
    assert.deepEqual(studentDashboard.students[0].monthlyDelivery, mentorSummary,
      "student and management views must agree on the same student's monthly phase and counts");
    return mentorSummary;
  };
  const readWorkflowTasks = async () => (await readDashboard()).workflowTasks;
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
    await applyD1Migrations(mf);
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
    const submittedMonth = await readMonthlyDelivery();
    assert.equal(submittedMonth.phase, "submitted");
    assert.equal(submittedMonth.total, 1);
    assert.equal(submittedMonth.pending, 1);
    assert.equal(submittedMonth.confirmed, 0);
    await confirmProgress(first.id);
    assert.deepEqual(await readMonthlyDelivery(), { ...submittedMonth, phase: "confirmed", pending: 0, confirmed: 1 });
    // Store an actual next-action result before superseding this progress. It
    // must remain a history record, while the problem follows its own lifecycle.
    await expectJson(await result(first.id, "next_action", 0, "independent_next_action", "已完成这一轮实验的后续整理。"));
    let next;

    await t.test("an open problem does not prevent the next student submission or its review", async () => {
      const before = (await readProblems()).find((record) => record.id === `progress:${first.id}:1:blocker`);
      assert.equal(before?.status, "open");
      next = await submitProgress("independent_second_progress", "第二批测量完成");
      assert.notEqual(next.id, first.id);
      const submittedDashboard = await readDashboard();
      assert.ok(submittedDashboard.pending.some((entry) => entry.id === next.id));
      assert.ok(!submittedDashboard.pending.some((entry) => entry.id === first.id),
        "previously accepted progress must not reappear in the review queue");
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
      const confirmedDashboard = await readDashboard();
      assert.deepEqual(confirmedDashboard.pending, [], "accepted progress leaves the review queue immediately");
      assert.equal(confirmedDashboard.metrics.pending, 0);
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM student_guidance_notes WHERE student_id = ?")
        .bind("independent-student").first()).count, 0, "ordinary progress approval must not create extra guidance tasks");
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
      const later = await submitProgress("independent_third_progress", "第三批测量完成");
      assert.ok((await readDashboard()).pending.some((entry) => entry.id === later.id));
      await confirmProgress(later.id);
      const reviewedDashboard = await readDashboard();
      assert.deepEqual(reviewedDashboard.pending, [], "the new approval clears its review task, even while another result awaits confirmation");
      assert.equal(reviewedDashboard.metrics.pending, 0);
      assert.equal(reviewedDashboard.metrics.resolutionPending, 1,
        "progress approval must preserve an independently pending problem result");
      assert.deepEqual(reviewedDashboard.workflowTasks.filter((task) => task.type === "resolution_verification"), verificationTasks);
      assert.equal((await readProblems()).find((item) => item.id === record.id)?.status, "pending");
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM student_guidance_notes WHERE student_id = ?")
        .bind("independent-student").first()).count, 0, "reviewing another progress entry must not manufacture guidance to replace its cleared review task");
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

    await t.test("new follow-up work can reference accepted progress without changing its approval or chosen deadline", async () => {
      const followUpBody = (sourceProgressEntryId, dueDate = "2099-03-17") => ({
        studentId: "independent-student", sourceProgressEntryId,
        guidanceType: "general", title: "下一阶段独立工作", content: "本次进展已确认，继续开展下一阶段研究。",
        nextAction: "完成新的对照实验", dueDate, acceptanceCriteria: "提供独立对照结果与误差说明。",
        verificationMode: "mentor_verify",
      });
      const progressState = () => db.prepare(`SELECT review_status, assessment, current_revision, reviewed_at,
        reviewer_note FROM progress_entries WHERE id = ?`).bind(next.id).first();
      const approvedState = await progressState();
      const approvedMonth = await readMonthlyDelivery();
      assert.equal(approvedMonth.phase, "confirmed");
      assert.equal(approvedMonth.confirmed, 3);
      for (const dueDate of ["2099-03-17", "2099-04-06"]) {
        const created = await expectJson(await json("/api/student-guidance", followUpBody(next.id, dueDate), "mentor"), 201);
        const guidance = await db.prepare(`SELECT source_progress_entry_id, due_date, status, verification_mode,
          mentor_user_id FROM student_guidance_notes WHERE id = ?`).bind(created.id).first();
        assert.deepEqual(guidance, { source_progress_entry_id: next.id, due_date: dueDate, status: "open",
          verification_mode: "mentor_verify", mentor_user_id: 702 });
        assert.deepEqual(await progressState(), approvedState, "a separately dated follow-up must not reopen or rewrite the approved progress");
        assert.deepEqual(await readMonthlyDelivery(), approvedMonth,
          "independent follow-up deadlines must not reset the confirmed monthly submission progress");
      }
      assert.deepEqual((await readDashboard()).pending, [], "creating follow-up work must not restore the source review task");
      const rejectedSource = async (body, actor = "mentor", status = 400) => {
        const payload = await expectJson(await json("/api/student-guidance", body, actor), status);
        assert.ok(payload.error);
      };
      await rejectedSource({ ...followUpBody(next.id), studentId: "independent-other" });
      await rejectedSource(followUpBody(next.id), "student", 403);
      for (const invalidId of [0, -1, Number.MAX_SAFE_INTEGER + 1]) await rejectedSource(followUpBody(invalidId));

      const pending = await submitProgress("independent_followup_pending", "尚未核验的实验结果");
      await rejectedSource(followUpBody(pending.id));
      await expectJson(await json("/api/reviews", { id: pending.id, action: "start_review" }, "mentor"));
      await rejectedSource(followUpBody(pending.id));
      await expectJson(await json("/api/reviews", { id: pending.id, action: "supplement", note: "请补充对照实验材料。" }, "mentor"));
      await rejectedSource(followUpBody(pending.id));

      // Existing AI-summary guidance stays supported, including a summary that
      // still needs supplementary evidence; this is separate from ordinary progress.
      const imported = await db.prepare(`INSERT INTO feishu_meeting_summary_imports
        (event_id,message_id,chat_id,raw_content,extracted_text,message_created_at)
        VALUES('independent-followup-event','independent-followup-message','synthetic-chat','{}','合成会议纪要',CURRENT_TIMESTAMP)
        RETURNING id`).first();
      await db.prepare(`INSERT INTO feishu_meeting_summary_links(import_id,student_id,progress_entry_id)
        VALUES(?,'independent-student',?)`).bind(imported.id, pending.id).run();
      await expectJson(await json("/api/student-guidance", followUpBody(pending.id, "2099-05-08"), "mentor"), 201);
      assert.equal((await db.prepare("SELECT review_status FROM progress_entries WHERE id = ?").bind(pending.id).first()).review_status,
        "changes_requested", "guidance attached to an AI summary must not change its review status");

      await db.prepare(`INSERT INTO progress_deletions(progress_entry_id,deleted_by_user_id,operation_id)
        VALUES(?,702,'independent-followup-deleted-source')`).bind(first.id).run();
      await rejectedSource(followUpBody(first.id));
      assert.deepEqual(await progressState(), approvedState);
    });

    await t.test("a stale review cannot claim, release or decide a newer student revision", async () => {
      const entry = await submitProgress("independent_revision_guard", "第一版待补充的实验记录");
      await expectJson(await json("/api/reviews", {
        id: entry.id, expectedRevision: 1, action: "supplement", note: "补充第二组对照结果。",
      }, "mentor"));
      await expectJson(await json("/api/progress", {
        id: entry.id, expectedRevision: 1, title: "第二版已补充的实验记录",
        summary: "第二版新增第二组对照结果，已修正第一版的实验说明。",
        evidence: "两组对照结果及重新计算的误差记录。",
        nextAction: "继续第三组对照实验", nextActionDueDate: "2099-12-31", blocker: "",
      }, "student", "PATCH"));

      const reviewState = async () => ({
        entry: await db.prepare("SELECT * FROM progress_entries WHERE id = ?").bind(entry.id).first(),
        revisions: (await db.prepare("SELECT * FROM progress_revisions WHERE progress_entry_id = ? ORDER BY revision_number")
          .bind(entry.id).all()).results,
        audit: (await db.prepare("SELECT * FROM progress_audit_events WHERE progress_entry_id = ? ORDER BY id")
          .bind(entry.id).all()).results,
        guidance: (await db.prepare("SELECT * FROM student_guidance_notes WHERE source_progress_entry_id = ? ORDER BY id")
          .bind(entry.id).all()).results,
      });
      const resubmitted = await reviewState();
      assert.equal(resubmitted.entry.current_revision, 2);
      assert.equal(resubmitted.entry.review_status, "submitted");
      assert.deepEqual(resubmitted.revisions.map((revision) => revision.review_status), ["changes_requested", "submitted"]);

      for (const action of ["start_review", "release_review", "substantive", "supporting", "supplement", "rejected"]) {
        const stale = await expectJson(await json("/api/reviews", {
          id: entry.id, expectedRevision: 1, action, note: "这份意见仅针对页面上的第一版。",
          ...(action === "supplement" ? { guidance: {
            nextAction: "不应从旧页面新增的补充任务", dueDate: "2099-07-19", acceptanceCriteria: "旧版标准",
          } } : {}),
        }, "mentor"), 409);
        assert.match(stale.error, /修订版本已变化.*刷新/);
        assert.deepEqual(await reviewState(), resubmitted, `stale ${action} must leave revisions, audit and guidance untouched`);
      }
      for (const expectedRevision of [null, 0, -1, 1.5, "2", true, Number.MAX_SAFE_INTEGER + 1]) {
        await expectJson(await json("/api/reviews", {
          id: entry.id, expectedRevision, action: "substantive", note: "无效版本不得被忽略。",
        }, "mentor"), 400);
      }
      assert.deepEqual(await reviewState(), resubmitted);

      await expectJson(await json("/api/reviews", { id: entry.id, expectedRevision: 2, action: "start_review" }, "mentor"));
      const claimed = await reviewState();
      await expectJson(await json("/api/reviews", { id: entry.id, expectedRevision: 1, action: "release_review" }, "mentor"), 409);
      assert.deepEqual(await reviewState(), claimed, "a stale page cannot release the newer revision's review claim");
      await expectJson(await json("/api/reviews", { id: entry.id, expectedRevision: 2, action: "release_review" }, "mentor"));
      await expectJson(await json("/api/reviews", {
        id: entry.id, expectedRevision: 2, action: "substantive", note: "已查看并核验第二版对照结果。",
      }, "mentor"));
      const confirmed = await reviewState();
      assert.equal(confirmed.entry.current_revision, 2);
      assert.equal(confirmed.entry.review_status, "accepted");
      assert.deepEqual(confirmed.revisions.map((revision) => revision.review_status), ["changes_requested", "accepted"]);
      assert.deepEqual(confirmed.guidance, []);
      assert.ok(!(await readDashboard()).pending.some((pending) => pending.id === entry.id));
    });
  } finally {
    await mf.dispose();
  }
});
