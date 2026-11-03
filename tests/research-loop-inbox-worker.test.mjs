import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { countLoopInboxByStudent, listLoopInboxItems } from "../lib/research-loop-inbox.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Mentor decision inbox (frontend plan FA1) against the built Worker. All
// rows are synthetic and seeded directly; no runner, agent or GitHub is used.
const SECRET_HEX = "9f".repeat(32);
const ITEM_KEYS = ["id", "kind", "studentId", "studentName", "taskId", "taskTitle", "objectId", "runNumber",
  "taskVersion", "technicalValidity", "title", "href", "waitingSince"].sort();
// The dashboard itself loads every scoped student, so keep its fixture under
// 100 students; the >100-student chunking is exercised on the library directly.
const CAP_STUDENTS = 50;
const CAP_TASKS_PER_STUDENT = 5;
const CHUNK_STUDENTS = 70;

test("research loop inbox: scope, self-exclusion, ordering and cap", { timeout: 240_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "loop-inbox-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => new Response("No external services in this test", { status: 502 }),
  });
  const personas = { student1: "student" };
  const dashboard = async (actor) => {
    const response = await mf.dispatchFetch("http://localhost/api/dashboard", {
      headers: { cookie: `tanyan_session=inbox-${actor}; tanyan_persona=${personas[actor] ?? "management"}` },
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  };
  const inbox = async (actor) => {
    const body = await dashboard(actor);
    assert.ok(Array.isArray(body.loopTasks), "staff dashboards carry loopTasks");
    assert.equal(body.metrics.loopPending, body.loopTasks.length);
    return body.loopTasks;
  };
  const ids = (items) => items.map((item) => item.id);

  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('ib-s1', '闭环学生甲', '博士', 2025, '实验', 1), ('ib-s2', '闭环学生乙', '硕士', 2025, '实验', 1),
      ('ib-s3', '已离组学生', '硕士', 2024, '实验', 0), ('ib-s4', '只读学生', '硕士', 2025, '实验', 1),
      ('ib-s5', '双身份学生', '博士', 2024, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (2001, 'ib-student-1', '闭环学生甲', 'student', 'ib-s1'), (2002, 'ib-student-2', '闭环学生乙', 'student', 'ib-s2'),
      (2011, 'ib-mentor-a', '导师甲', 'mentor', NULL), (2012, 'ib-mentor-b', '导师乙', 'mentor', NULL),
      (2013, 'ib-mentor-c', '未分配导师', 'mentor', NULL), (2014, 'ib-mentor-d', '只读导师', 'mentor', NULL),
      (2015, 'ib-mentor-bulk', '批量导师', 'mentor', NULL),
      (2021, 'ib-root', '超级管理员', 'superadmin', NULL), (2022, 'ib-root-dual', '双身份管理员', 'superadmin', 'ib-s5')`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (2011, 'ib-s1', 1, 1), (2011, 'ib-s3', 1, 1), (2011, 'ib-s4', 0, 1), (2012, 'ib-s2', 1, 1), (2012, 'ib-s1', 1, 0),
      (2014, 'ib-s1', 0, 1)`).run();
    const actors = [[2001, "student1"], [2011, "mentorA"], [2012, "mentorB"], [2013, "mentorC"], [2014, "mentorD"],
      [2015, "mentorBulk"], [2021, "root"], [2022, "rootDual"]];
    for (const [id, actor] of actors) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`inbox-${actor}`), id).run();
    }

    // Tasks: [id, student, status, version, createdBy, updatedAt].
    const tasks = [
      ["t1", "ib-s1", "draft", 2, 2001, "2026-10-01 08:00:00"],
      ["t2", "ib-s1", "draft", 1, 2011, "2026-10-01 07:00:00"], // mentor A's own draft
      ["t3", "ib-s1", "confirmed", 1, 2001, "2026-09-01 00:00:00"],
      ["t4", "ib-s2", "draft", 1, 2002, "2026-10-05 00:00:00"],
      ["t5", "ib-s3", "draft", 1, 2002, "2026-09-01 00:00:00"], // inactive student
      ["t6", "ib-s4", "draft", 1, 2002, "2026-10-05 01:00:00"], // mentor A cannot review
      ["t7", "ib-s5", "draft", 1, 2011, "2026-10-05 02:00:00"], // rootDual's own student record
      ["t8", "ib-s1", "closed", 1, 2001, "2026-09-01 00:00:00"],
    ];
    for (const [id, studentId, status, version, createdBy, updatedAt] of tasks) {
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id,
        create_mutation_id, last_mutation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, studentId, `合成任务${id}`, status, version, status === "draft" ? null : 1, createdBy, `c-${id}`, `m-${id}`, updatedAt, updatedAt).run();
    }
    // Bulk students assigned to mentorBulk, each with `perStudent` drafts by mentor A;
    // task `${prefix}-task-NNN` is the NNN-th oldest of the group.
    const seedBulk = async (prefix, count, perStudent, startMs) => {
      const studentIds = Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`);
      await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
        ${studentIds.map((id) => `('${id}', '批量学生${id}', '硕士', 2025, '实验', 1)`).join(", ")}`).run();
      await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
        ${studentIds.map((id) => `(2015, '${id}', 1, 1)`).join(", ")}`).run();
      const rows = studentIds.flatMap((studentId, index) => Array.from({ length: perStudent }, (_, slot) => {
        const order = index * perStudent + slot;
        const at = new Date(startMs + order * 60_000).toISOString().replace("T", " ").slice(0, 19);
        return `('${prefix}-task-${String(order).padStart(3, "0")}', '${studentId}', '批量任务', 'draft', 1, 2011, '${prefix}-c-${order}', '${prefix}-m-${order}', '${at}', '${at}')`;
      }));
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, created_by_user_id,
        create_mutation_id, last_mutation_id, created_at, updated_at) VALUES ${rows.join(", ")}`).run();
    };
    // 50 students x 5 drafts = 250 items, newer than every core item: exercises the 200 cap.
    await seedBulk("cp", CAP_STUDENTS, CAP_TASKS_PER_STUDENT, Date.UTC(2026, 9, 20));

    await db.prepare(`INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES
      ('rnr_ib_agent', '代理', 'agent', ?), ('rnr_ib_compute', '计算', 'compute', ?)`).bind("a1".repeat(32), "b2".repeat(32)).run();
    await db.prepare("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_ib', 2001, 'codex', 'rnr_ib_agent')").run();
    await db.prepare(`INSERT INTO registered_entrypoints(id, github_repository_id, name, argv_json, image_ref, created_by_user_id)
      VALUES ('ep_ib', 6001, 'train', '["python","train.py"]', 'registry.lab/train@sha256:${"c".repeat(64)}', 2021)`).run();
    await db.prepare(`INSERT INTO dataset_versions(id, label, runner_id, manifest_sha256, egress_policy_json, created_by_user_id)
      VALUES ('dv_ib', '合成数据', 'rnr_ib_compute', ?, '{}', 2021)`).bind("d".repeat(64)).run();

    // Change requests: [id, requestedBy, status, requiresExtra, approvedAt, createdAt].
    const changes = [
      ["cr1", 2001, "pending_review", 1, null, "2026-10-06 09:00:00"],
      ["cr2", 2011, "pending_review", 1, null, "2026-10-02 08:00:00"], // requested by mentor A
      ["cr3", 2001, "pending_review", 1, "2026-10-02 09:00:00", "2026-09-02 08:00:00"], // already approved
      ["cr4", 2001, "pending_review", 0, null, "2026-09-02 08:00:00"], // no protected paths
      ["cr5", 2001, "open", 1, null, "2026-09-02 08:00:00"], // already published
    ];
    for (const [id, requestedBy, status, requiresExtra, approvedAt, createdAt] of changes) {
      await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
        base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id, created_at)
        VALUES (?, 't3', 1, 'ib-s1', 'codex', 'cred_ib', 6001, ?, ?, 'change_ready', ?, ?, ?)`)
        .bind(`att_${id}`, "0".repeat(40), SECRET_HEX, `idem-${id}`, requestedBy, createdAt).run();
      await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name,
        head_commit_sha, status, requires_extra_review, extra_review_approved_by_user_id, extra_review_approved_at, created_at, updated_at)
        VALUES (?, 't3', ?, 'ib-s1', 6001, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, `att_${id}`, "0".repeat(40), `tanyan/ib/${id}`, "1".repeat(40), status, requiresExtra,
          approvedAt ? 2012 : null, approvedAt, createdAt, createdAt).run();
    }

    // Runs on t3 in creation order: [id, status, createdBy, createdAt, validity, resultAt, reviewState].
    const runs = [
      ["run_a", "completed", 2001, "2026-09-01 00:00:00", "invalid", "2026-10-03 08:00:00", "pending"],
      ["run_b", "completed", 2001, "2026-09-02 00:00:00", "valid", "2026-09-05 08:00:00", "accepted"],
      ["run_c", "completed", 2001, "2026-09-03 00:00:00", "valid", "2026-10-04 08:00:00", null],
      ["run_d", "awaiting_approval", 2001, "2026-10-06T08:00:00.000Z", null, null, null],
      ["run_e", "awaiting_approval", 2011, "2026-10-07 01:00:00", null, null, null], // created by mentor A
      ["run_f", "awaiting_approval", 2021, "2026-10-07 02:00:00", null, null, null], // created by root
      ["run_g", "queued", 2001, "2026-10-08 00:00:00", null, null, null],
    ];
    for (const [index, [id, status, createdBy, createdAt, validity, resultAt, reviewState]] of runs.entries()) {
      const spec = (index + 1).toString(16).padStart(2, "0").repeat(32);
      await db.prepare(`INSERT INTO run_specs(sha256, canonical_json, task_id, task_version, student_id, github_repository_id,
        executed_commit_sha, entrypoint_id, dataset_version_id, created_by_user_id) VALUES (?, '{}', 't3', 1, 'ib-s1', 6001, ?, 'ep_ib', 'dv_ib', ?)`)
        .bind(spec, "2".repeat(40), createdBy).run();
      await db.prepare(`INSERT INTO runs(id, run_spec_sha256, attempt, task_id, student_id, status, idempotency_key, submit_tag, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, 1, 't3', 'ib-s1', ?, ?, ?, ?, ?, ?)`).bind(id, spec, status, `idem-${id}`, `tanyan-${id}`, createdBy, createdAt, createdAt).run();
      if (validity) {
        await db.prepare(`INSERT INTO run_results(run_id, manifest_sha256, manifest_json, technical_validity, created_at) VALUES (?, ?, '{}', ?, ?)`)
          .bind(id, SECRET_HEX, validity, resultAt).run();
      }
      if (reviewState) await db.prepare("INSERT INTO result_reviews(run_id, state) VALUES (?, ?)").bind(id, reviewState).run();
    }

    const mentorAExpected = ["task_confirmation:t1", "result_review:run_a", "result_review:run_c", "run_approval:run_d",
      "change_extra_review:cr1", "run_approval:run_f"];

    await t.test("each kind appears for an assigned reviewer, oldest first, with titles and deep links", async () => {
      const items = await inbox("mentorA");
      assert.deepEqual(ids(items), mentorAExpected, "julianday ordering puts the ISO run_d before cr1 on the same day");
      const byId = new Map(items.map((item) => [item.id, item]));
      assert.deepEqual(byId.get("task_confirmation:t1"), {
        id: "task_confirmation:t1", kind: "task_confirmation", studentId: "ib-s1", studentName: "闭环学生甲", taskId: "t1",
        taskTitle: "合成任务t1", objectId: "t1", runNumber: null, taskVersion: 2, technicalValidity: null, title: "确认第 2 版任务",
        href: "/students/ib-s1#research-task-t1", waitingSince: "2026-10-01 08:00:00",
      });
      const extra = byId.get("change_extra_review:cr1");
      assert.equal(extra.title, "额外审查：变更触及受保护路径");
      assert.equal(extra.objectId, "cr1");
      assert.equal(extra.href, "/students/ib-s1#research-task-t3");
      assert.equal(extra.waitingSince, "2026-10-06 09:00:00");
      const approval = byId.get("run_approval:run_d");
      assert.equal(approval.title, "批准运行 #4");
      assert.equal(approval.runNumber, 4);
      assert.equal(approval.href, "/students/ib-s1#research-run-run_d");
      assert.equal(byId.get("run_approval:run_f").title, "批准运行 #6");
      const invalid = byId.get("result_review:run_a");
      assert.equal(invalid.title, "评审运行 #1 的结果（技术无效）");
      assert.equal(invalid.technicalValidity, "invalid");
      assert.equal(invalid.waitingSince, "2026-10-03 08:00:00");
      const valid = byId.get("result_review:run_c");
      assert.equal(valid.title, "评审运行 #3 的结果");
      assert.equal(valid.technicalValidity, "valid");
      assert.equal(valid.runNumber, 3);
    });

    await t.test("items carry only the contract fields and no hashes or secrets", async () => {
      for (const actor of ["mentorA", "root"]) {
        const items = await inbox(actor);
        for (const item of items) assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS);
        const text = JSON.stringify(items);
        for (const secret of [SECRET_HEX, "0".repeat(40), "1".repeat(40), "2".repeat(40), "01".repeat(32), "tanyan-run", "idem-"]) {
          assert.ok(!text.includes(secret), `${actor} inbox leaks ${secret}`);
        }
      }
    });

    await t.test("scope isolation: unassigned, read-only, inactive assignment and inactive student", async () => {
      assert.deepEqual(await inbox("mentorC"), [], "unassigned mentor");
      assert.deepEqual(await inbox("mentorD"), [], "can_review = 0 mentor");
      assert.deepEqual(ids(await inbox("mentorB")), ["task_confirmation:t4"], "inactive assignment to ib-s1 is ignored");
      const mentorA = await inbox("mentorA");
      assert.ok(mentorA.every((item) => item.studentId === "ib-s1"), "no ib-s3 (inactive) or ib-s4 (read-only)");
      const student = await dashboard("student1");
      assert.equal((student.loopTasks ?? []).length, 0, "students never get items");
    });

    await t.test("self-exclusion: own draft, own requested attempt, own run", async () => {
      const mentorA = ids(await inbox("mentorA"));
      for (const own of ["task_confirmation:t2", "change_extra_review:cr2", "run_approval:run_e"]) assert.ok(!mentorA.includes(own), own);
      for (const done of ["change_extra_review:cr3", "change_extra_review:cr4", "change_extra_review:cr5", "result_review:run_b",
        "run_approval:run_g", "task_confirmation:t3", "task_confirmation:t8"]) {
        assert.ok(!mentorA.includes(done), `${done} needs no decision`);
      }
    });

    await t.test("superadmin sees every active student but not their own runs, capped at 200", async () => {
      const rootItems = await inbox("root");
      assert.equal(rootItems.length, 200);
      assert.deepEqual(ids(rootItems.slice(0, 11)), ["task_confirmation:t2", "task_confirmation:t1", "change_extra_review:cr2",
        "result_review:run_a", "result_review:run_c", "task_confirmation:t4", "task_confirmation:t6", "task_confirmation:t7",
        "run_approval:run_d", "change_extra_review:cr1", "run_approval:run_e"]);
      assert.ok(rootItems.slice(11).every((item) => item.kind === "task_confirmation" && item.studentId.startsWith("cp-")));
      assert.ok(!ids(rootItems).includes("run_approval:run_f"), "no self-approval for superadmin");
      assert.ok(!ids(rootItems).includes("task_confirmation:t5"), "inactive student excluded");
      const dual = await inbox("rootDual");
      assert.deepEqual(ids(dual.slice(0, 11)), ["task_confirmation:t2", "task_confirmation:t1", "change_extra_review:cr2",
        "result_review:run_a", "result_review:run_c", "task_confirmation:t4", "task_confirmation:t6",
        "run_approval:run_d", "change_extra_review:cr1", "run_approval:run_e", "run_approval:run_f"], "never their own student record");
    });

    await t.test("the dashboard keeps the oldest 200 items in order", async () => {
      const items = await inbox("mentorBulk");
      assert.deepEqual(ids(items), Array.from({ length: 200 }, (_, order) => `task_confirmation:cp-task-${String(order).padStart(3, "0")}`));
    });

    await t.test("countLoopInboxByStudent agrees with the list", async () => {
      for (const viewer of [{ id: 2011, role: "admin" }, { id: 2012, role: "admin" }, { id: 2014, role: "admin" }]) {
        const list = await listLoopInboxItems(db, viewer);
        const grouped = {};
        for (const item of list) grouped[item.studentId] = (grouped[item.studentId] ?? 0) + 1;
        assert.deepEqual(await countLoopInboxByStudent(db, viewer), grouped);
      }
      const rootCounts = await countLoopInboxByStudent(db, { id: 2021, role: "superadmin" });
      assert.deepEqual({ s1: rootCounts["ib-s1"], s2: rootCounts["ib-s2"], s3: rootCounts["ib-s3"], s4: rootCounts["ib-s4"], s5: rootCounts["ib-s5"] },
        { s1: 8, s2: 1, s3: undefined, s4: 1, s5: 1 });
      assert.equal(Object.values(rootCounts).reduce((sum, count) => sum + count, 0), 11 + CAP_STUDENTS * CAP_TASKS_PER_STUDENT);
      assert.ok(Object.entries(rootCounts).every(([id, count]) => !id.startsWith("cp-") || count === CAP_TASKS_PER_STUDENT));
      for (const role of ["student", "pending"]) {
        assert.deepEqual(await listLoopInboxItems(db, { id: 2001, role }), []);
        assert.deepEqual(await countLoopInboxByStudent(db, { id: 2001, role }), {});
      }
    });

    await t.test("decided items leave the queue immediately", async () => {
      await db.prepare("UPDATE runs SET status = 'queued' WHERE id = 'run_d'").run();
      await db.prepare("INSERT INTO result_reviews(run_id, state) VALUES ('run_c', 'needs_followup')").run();
      await db.prepare("UPDATE change_requests SET extra_review_approved_at = CURRENT_TIMESTAMP, extra_review_approved_by_user_id = 2011 WHERE id = 'cr1'").run();
      await db.prepare("UPDATE research_tasks SET status = 'confirmed', confirmed_version = 2 WHERE id = 't1'").run();
      assert.deepEqual(ids(await inbox("mentorA")), ["result_review:run_a", "run_approval:run_f"]);
    });

    await t.test("more than 100 students are chunked under the bind limit and merged oldest first", async () => {
      // 70 more students with one older draft each: 120 students span two chunks.
      await seedBulk("bk", CHUNK_STUDENTS, 1, Date.UTC(2026, 8, 15));
      const viewer = { id: 2015, role: "admin" };
      const items = await listLoopInboxItems(db, viewer);
      assert.deepEqual(ids(items), [
        ...Array.from({ length: CHUNK_STUDENTS }, (_, order) => `task_confirmation:bk-task-${String(order).padStart(3, "0")}`),
        ...Array.from({ length: 200 - CHUNK_STUDENTS }, (_, order) => `task_confirmation:cp-task-${String(order).padStart(3, "0")}`),
      ]);
      const counts = await countLoopInboxByStudent(db, viewer);
      assert.equal(Object.keys(counts).length, CAP_STUDENTS + CHUNK_STUDENTS);
      assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), CHUNK_STUDENTS + CAP_STUDENTS * CAP_TASKS_PER_STUDENT);
      const rootItems = await listLoopInboxItems(db, { id: 2021, role: "superadmin" });
      assert.equal(rootItems.length, 200);
      assert.equal(rootItems[0].id, "task_confirmation:bk-task-000");
    });
  } finally {
    await mf.dispose();
  }
});
