import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";

// Exercise the built HTTP handlers and real D1 SQL with synthetic records only.
test("student-filtered reads preserve nested data and enforce the existing account scope", { timeout: 120000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")]
      .map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "student-scoped-reads-test" },
    r2Buckets: ["FILES"],
  });
  const origin = "http://localhost";
  const get = (path, token, persona = "management") => mf.dispatchFetch(origin + path, {
    headers: { cookie: `tanyan_session=${token}; tanyan_persona=${persona}` },
  });
  const read = async (path, token, persona) => {
    const response = await get(path, token, persona);
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  try {
    await mf.dispatchFetch(origin + "/api/health/ready");
    const db = await mf.getD1Database("DB");
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('scope-a', '测试甲', '博士', 2024, '实验', 1),
      ('scope-b', '测试乙', '硕士', 2025, '实验', 1),
      ('scope-c', '测试丙', '硕士', 2025, '实验', 1),
      ('scope-inactive', '停用测试学生', '硕士', 2025, '实验', 0)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (101, 'scope-owner', '测试超管', 'superadmin', 'scope-c'),
      (102, 'scope-student', '测试学生', 'student', 'scope-a'),
      (103, 'scope-mentor', '测试导师', 'mentor', NULL),
      (104, 'scope-observer', '只读导师', 'mentor', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (103, 'scope-a', 1, 1), (103, 'scope-b', 0, 1), (103, 'scope-c', 1, 0),
      (104, 'scope-a', 0, 1)`).run();
    for (const [id, token] of [[101, "scope-owner"], [102, "scope-student"], [103, "scope-mentor"], [104, "scope-observer"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(token), id).run();
    }
    for (const [index, studentId] of ["scope-a", "scope-b", "scope-c", "scope-inactive"].entries()) {
      const id = index + 1;
      const pendingId = id * 10;
      const acceptedId = pendingId + 1;
      await db.batch([
        db.prepare(`INSERT INTO research_proposals(id, student_id, title, status, current_version, created_by_user_id)
          VALUES (?, ?, ?, 'approved', 1, 101)`).bind(id, studentId, `${studentId}方案`),
        db.prepare(`INSERT INTO research_proposal_versions(proposal_id, version_number, snapshot_json, submitted_by_user_id)
          VALUES (?, 1, '{}', 102)`).bind(id),
        db.prepare(`INSERT INTO research_milestones(id, proposal_id, title, target_date, status)
          VALUES (?, ?, ?, '2020-01-01', 'blocked')`).bind(id, id, `${studentId}节点`),
        db.prepare(`INSERT INTO student_papers(id, student_id, title, created_by_user_id)
          VALUES (?, ?, ?, 101)`).bind(id, studentId, `${studentId}论文`),
        db.prepare(`INSERT INTO progress_entries(id, student_id, kind, title, submitted_by_user_id, current_revision)
          VALUES (?, ?, '论文', ?, 102, 2)`).bind(pendingId, studentId, `${studentId}待确认`),
        db.prepare(`INSERT INTO progress_revisions(progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
          VALUES (?, 1, ?, 102), (?, 2, ?, 102)`)
          .bind(pendingId, JSON.stringify({ title: `${studentId}旧版` }), pendingId,
            JSON.stringify({ title: `${studentId}新版`, _operationToken: "must-not-leak", paper: { targetVenue: `${studentId}快照期刊` } })),
        db.prepare(`INSERT INTO paper_progress_details(progress_entry_id, paper_id, stage, next_action, next_action_due_date)
          VALUES (?, ?, 'drafting', '完善论文', '2030-01-01')`).bind(pendingId, id),
        db.prepare(`INSERT INTO progress_evidence_sources(progress_entry_id, source_type, label, revision_number)
          VALUES (?, 'manual', ?, 2)`).bind(pendingId, `${studentId}证据`),
        db.prepare(`INSERT INTO progress_attachments(progress_entry_id, storage_key, file_name, size_bytes, content_sha256, revision_number, uploaded_by_user_id)
          VALUES (?, ?, ?, 10, '0123456789abcdef', 2, 102)`).bind(pendingId, `${studentId}/file`, `${studentId}.pdf`),
        db.prepare(`INSERT INTO progress_audit_events(progress_entry_id, actor_user_id, action, note)
          VALUES (?, 102, 'submit', ?)`).bind(pendingId, `${studentId}审计`),
        db.prepare(`INSERT INTO progress_entries(id, student_id, kind, title, submitted_by_user_id, status, review_status, assessment, reviewed_at)
          VALUES (?, ?, '课题', ?, 102, 'substantive', 'accepted', 'substantive', CURRENT_TIMESTAMP)`)
          .bind(acceptedId, studentId, `${studentId}已确认`),
        db.prepare(`INSERT INTO progress_revisions(progress_entry_id, revision_number, snapshot_json, submitted_by_user_id, review_status, assessment, reviewed_at)
          VALUES (?, 1, '{}', 102, 'accepted', 'substantive', CURRENT_TIMESTAMP)`).bind(acceptedId),
        db.prepare(`INSERT INTO project_progress_details(progress_entry_id, next_action, next_action_due_date)
          VALUES (?, '完成测量', '2030-01-01')`).bind(acceptedId),
        db.prepare(`INSERT INTO progress_resolutions(student_id, progress_entry_id, revision_number, item_kind, source_title, source_text, track_type, status, submitted_by_user_id, last_request_id)
          VALUES (?, ?, 1, 'next_action', ?, '完成测量', 'project', 'pending', 102, ?)`)
          .bind(studentId, acceptedId, `${studentId}完成结果`, `${studentId}-result`),
        db.prepare(`INSERT INTO student_guidance_notes(student_id, mentor_user_id, title, content, student_reported_at)
          VALUES (?, 103, ?, '指导内容', CURRENT_TIMESTAMP)`).bind(studentId, `${studentId}指导`),
      ]);
    }

    await t.test("superadmin filter narrows every collection before history is loaded", async () => {
      const all = await read("/api/dashboard", "scope-owner");
      assert.deepEqual(all.students.map((student) => student.id).sort(), ["scope-a", "scope-b", "scope-c"]);
      const one = await read("/api/dashboard?studentId=scope-a", "scope-owner");
      assert.deepEqual(one.students, all.students.filter((student) => student.id === "scope-a"));
      assert.deepEqual(one.papers, all.papers.filter((paper) => paper.student_id === "scope-a"));
      assert.deepEqual(one.pending, all.pending.filter((entry) => entry.student_id === "scope-a"));
      assert.deepEqual(one.workflowTasks, all.workflowTasks.filter((task) => task.studentId === "scope-a"));
      assert.equal(one.metrics.total, 1);
      assert.equal(one.papers[0].update_count, 1);
      assert.equal(one.papers[0].pending_count, 1);
      assert.equal(one.pending[0].can_finalize, true);
      const progress = one.students[0].progress.find((entry) => entry.id === 10);
      assert.equal(progress.paper.target_venue, "scope-a快照期刊");
      assert.deepEqual(progress.revisions.map((revision) => revision.revision_number), [2, 1]);
      assert.equal(progress.evidence_sources[0].label, "scope-a证据");
      assert.equal(progress.attachments[0].file_name, "scope-a.pdf");
      assert.equal(progress.audit[0].note, "scope-a审计");
      assert.equal(one.students[0].progress.find((entry) => entry.id === 11).follow_up_states.next_action, "pending");
      assert.ok(one.workflowTasks.some((task) => task.type === "resolution_verification"));
      assert.ok(one.workflowTasks.some((task) => task.type === "blocked_milestone"));
      assert.ok(one.workflowTasks.some((task) => task.type === "guidance_verification"));
      assert.doesNotMatch(JSON.stringify(one), /scope-b|scope-inactive|must-not-leak/);
      const proposals = await read("/api/proposals", "scope-owner");
      const scoped = await read("/api/proposals?studentId=scope-a", "scope-owner");
      assert.deepEqual(scoped.proposals, proposals.proposals.filter((proposal) => proposal.student_id === "scope-a"));
      assert.equal(scoped.proposals[0].milestones[0].title, "scope-a节点");
      assert.equal(scoped.proposals[0].can_review, true);
      assert.equal(proposals.proposals.find((proposal) => proposal.student_id === "scope-c").can_review, false);
    });

    await t.test("mentor assignment and can_review remain distinct", async () => {
      const all = await read("/api/dashboard", "scope-mentor");
      assert.deepEqual(all.students.map((student) => student.id).sort(), ["scope-a", "scope-b"]);
      const proposals = await read("/api/proposals", "scope-mentor");
      assert.equal(proposals.proposals.find((proposal) => proposal.student_id === "scope-a").can_review, true);
      assert.equal(proposals.proposals.find((proposal) => proposal.student_id === "scope-b").can_review, false);
      await db.prepare("UPDATE research_proposal_versions SET submitted_by_user_id = 103 WHERE proposal_id = 1").run();
      const selfAuthored = await read("/api/proposals?studentId=scope-a", "scope-mentor");
      assert.equal(selfAuthored.proposals[0].can_review, false);
      await db.prepare("UPDATE research_proposal_versions SET submitted_by_user_id = 102 WHERE proposal_id = 1").run();
      for (const path of ["/api/dashboard", "/api/proposals"]) {
        const allowed = await read(`${path}?studentId=scope-a`, "scope-mentor");
        assert.equal((allowed.students ?? allowed.proposals).length, 1);
        assert.equal((await get(`${path}?studentId=scope-c`, "scope-mentor")).status, 403);
        assert.equal((await get(`${path}?studentId=missing-student`, "scope-mentor")).status, 403);
      }
      const observer = await read("/api/proposals?studentId=scope-a", "scope-observer");
      assert.equal(observer.proposals[0].can_review, false);
      const observerDashboard = await read("/api/dashboard?studentId=scope-a", "scope-observer");
      assert.equal(observerDashboard.pending[0].can_finalize, false);
    });

    await t.test("student and dual-persona sessions cannot expand their scope", async () => {
      const own = await read("/api/dashboard?studentId=scope-a", "scope-student", "student");
      assert.deepEqual(own.students.map((student) => student.id), ["scope-a"]);
      assert.equal((await get("/api/dashboard?studentId=scope-b", "scope-student", "student")).status, 403);
      assert.equal((await get("/api/proposals?studentId=scope-a", "scope-student", "student")).status, 403);
      const dual = await read("/api/dashboard?studentId=scope-c", "scope-owner", "student");
      assert.deepEqual(dual.students.map((student) => student.id), ["scope-c"]);
      assert.equal((await get("/api/dashboard?studentId=scope-a", "scope-owner", "student")).status, 403);
      assert.equal((await get("/api/proposals?studentId=scope-a", "scope-owner", "student")).status, 403);
    });

    await t.test("invalid filters and inactive students never trigger an unfiltered fallback", async () => {
      for (const path of ["/api/dashboard", "/api/proposals"]) {
        assert.equal((await get(`${path}?studentId=`, "scope-owner")).status, 400);
        assert.equal((await get(`${path}?studentId=${"x".repeat(81)}`, "scope-owner")).status, 400);
        const inactive = await read(`${path}?studentId=scope-inactive`, "scope-owner");
        assert.deepEqual(inactive.students ?? inactive.proposals, []);
        const missing = await read(`${path}?studentId=missing-student`, "scope-owner");
        assert.deepEqual(missing.students ?? missing.proposals, []);
        assert.equal((await get(`${path}?studentId=scope-a`, "invalid-session")).status, 401);
      }
    });

    await t.test("older problem results stay in mentor inbox while scope, review rights and source deletion remain enforced", async () => {
      for (const [index, studentId] of ["scope-a", "scope-b", "scope-c", "scope-inactive"].entries()) {
        const entryId = (index + 1) * 10 + 1;
        const newerId = 400 + index;
        await db.batch([
          db.prepare(`INSERT INTO progress_resolutions(student_id,progress_entry_id,revision_number,item_kind,
            source_title,source_text,track_type,status,submitted_by_user_id,last_request_id)
            VALUES(?,?,1,'blocker','早期问题','设备已经修复','project','pending',102,?)`)
            .bind(studentId, entryId, `${studentId}-problem-result`),
          db.prepare(`INSERT INTO progress_entries(id,student_id,kind,title,review_status,submitted_by_user_id)
            VALUES(?,?,'项目','后续项目进展','submitted',102)`).bind(newerId, studentId),
          db.prepare(`INSERT INTO project_progress_details(progress_entry_id,next_action,next_action_due_date)
            VALUES(?,'后续计划','2099-12-31')`).bind(newerId),
          db.prepare(`INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,review_status,created_at)
            VALUES(?,1,'{}','submitted','2098-01-01 00:00:00')`).bind(newerId),
        ]);
      }
      const tasks = (payload) => payload.workflowTasks.filter(task => task.type === "resolution_verification");
      const all = tasks(await read("/api/dashboard", "scope-owner"));
      assert.deepEqual(all.map(task => task.studentId).sort(), ["scope-a", "scope-b"]);
      assert.ok(all.every(task => task.itemKind === "blocker" && task.revisionNumber === 1));
      const scoped = tasks(await read("/api/dashboard?studentId=scope-a", "scope-owner"));
      assert.deepEqual(scoped, all.filter(task => task.studentId === "scope-a"));
      assert.equal(tasks(await read("/api/dashboard?studentId=scope-inactive", "scope-owner")).length, 0);
      assert.deepEqual(tasks(await read("/api/dashboard", "scope-mentor")).map(task => task.studentId), ["scope-a"]);
      assert.equal(tasks(await read("/api/dashboard", "scope-observer")).length, 0);
      assert.equal(tasks(await read("/api/dashboard", "scope-student", "student")).length, 0);
      await db.prepare("UPDATE progress_resolutions SET submitted_by_user_id=101 WHERE student_id='scope-b' AND item_kind='blocker'").run();
      assert.equal(tasks(await read("/api/dashboard?studentId=scope-b", "scope-owner")).length, 0, "the submitter cannot review their own result");
      await db.prepare("UPDATE mentor_student_assignments SET can_review=0 WHERE mentor_user_id=103 AND student_id='scope-a'").run();
      assert.equal(tasks(await read("/api/dashboard", "scope-mentor")).length, 0);
      await db.prepare("INSERT INTO progress_deletions(progress_entry_id,deleted_by_user_id,operation_id) VALUES(11,101,'delete-old-problem-source')").run();
      assert.equal(tasks(await read("/api/dashboard?studentId=scope-a", "scope-owner")).length, 0);
    });

    await t.test("520 progress entries load all nested history within D1's 100-variable limit", async () => {
      await db.prepare(`WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 26
      ) INSERT INTO students(id, display_name, degree, grade_year, stage)
        SELECT 'bulk-' || printf('%02d', n), '规模测试' || n, '硕士', 2025, '实验' FROM numbers`).run();
      await db.prepare(`WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 520
      ) INSERT INTO progress_entries(id, student_id, kind, title, submitted_by_user_id, current_revision, submitted_at)
        SELECT 1000 + n, 'bulk-' || printf('%02d', (n - 1) / 20 + 1), '实验',
          '批量进展' || n, 102, 2, '2030-01-01 00:00:00' FROM numbers`).run();
      await db.batch([
        db.prepare(`INSERT INTO progress_revisions(progress_entry_id, revision_number, snapshot_json, submitted_by_user_id, created_at)
          SELECT id, 1, '{}', 102, '2030-01-01 00:00:00' FROM progress_entries WHERE id > 1000
          UNION ALL SELECT id, 2, '{}', 102, '2030-01-02 00:00:00' FROM progress_entries WHERE id > 1000`),
        db.prepare(`INSERT INTO progress_evidence_sources(progress_entry_id, source_type, label, revision_number, created_at)
          SELECT id, 'manual', 'first', 1, '2030-01-01 00:00:00' FROM progress_entries WHERE id > 1000
          UNION ALL SELECT id, 'manual', 'second', 2, '2030-01-02 00:00:00' FROM progress_entries WHERE id > 1000`),
        db.prepare(`INSERT INTO progress_attachments(progress_entry_id, storage_key, file_name, size_bytes, content_sha256, revision_number, uploaded_by_user_id, created_at)
          SELECT id, 'bulk/' || id || '/first', 'first.pdf', 10, '0123456789abcdef', 1, 102, '2030-01-01 00:00:00'
            FROM progress_entries WHERE id > 1000
          UNION ALL SELECT id, 'bulk/' || id || '/second', 'second.pdf', 10, '0123456789abcdef', 2, 102, '2030-01-02 00:00:00'
            FROM progress_entries WHERE id > 1000`),
        db.prepare(`INSERT INTO progress_audit_events(progress_entry_id, actor_user_id, action, note, created_at)
          SELECT id, 102, 'submit', 'first', '2030-01-01 00:00:00' FROM progress_entries WHERE id > 1000
          UNION ALL SELECT id, 102, 'submit', 'second', '2030-01-02 00:00:00' FROM progress_entries WHERE id > 1000`),
      ]);
      const all = await read("/api/dashboard", "scope-owner");
      const bulkStudents = all.students.filter((student) => student.id.startsWith("bulk-"));
      assert.equal(bulkStudents.length, 26);
      assert.ok(bulkStudents.every((student) => student.progress.length === 20));
      for (const entry of bulkStudents.flatMap((student) => student.progress)) {
        assert.deepEqual(entry.revisions.map((revision) => revision.revision_number), [2, 1]);
        assert.deepEqual(entry.evidence_sources.map((source) => source.label), ["first", "second"]);
        assert.deepEqual(entry.attachments.map((attachment) => attachment.file_name), ["first.pdf", "second.pdf"]);
        assert.deepEqual(entry.audit.map((event) => event.note), ["second", "first"]);
      }
      assert.equal(all.pending.filter((entry) => entry.student_id.startsWith("bulk-")).length, 520);
      const one = await read("/api/dashboard?studentId=bulk-01", "scope-owner");
      assert.deepEqual(one.students, bulkStudents.filter((student) => student.id === "bulk-01"));

      // Crossing the existing 1000-entry response cap must still select the
      // newest entries globally, rather than applying the cap separately per chunk.
      await db.prepare(`WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 600
      ) INSERT INTO progress_entries(id, student_id, kind, title, submitted_by_user_id, submitted_at)
        SELECT 2000 + n, 'bulk-01', '实验', '新增批量进展' || n, 102, '2031-01-01 00:00:00' FROM numbers`).run();
      await db.prepare(`INSERT INTO progress_revisions(progress_entry_id, revision_number, snapshot_json, submitted_by_user_id)
        SELECT id, 1, '{}', 102 FROM progress_entries WHERE id > 2000`).run();
      const capped = await read("/api/dashboard", "scope-owner");
      const progress = capped.students.flatMap((student) => student.progress);
      assert.equal(progress.length, 1000);
      assert.equal(progress.filter((entry) => entry.id > 2000).length, 600);
      assert.deepEqual(progress.filter((entry) => entry.id < 2000).map((entry) => entry.id).sort((a, b) => a - b),
        Array.from({ length: 400 }, (_, index) => 1121 + index));
      assert.ok(progress.every((entry) => entry.revisions.length > 0));
    });
  } finally {
    await mf.dispose();
  }
});
