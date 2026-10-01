import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { acceptedTrackProgressSql } from "../lib/dashboard-overview/query-sql.ts";
import * as accessPolicy from "../lib/access-policy.ts";
import * as resolution from "../lib/progress-resolution.ts";
import * as blocker from "../lib/progress-blocker.ts";

const migrations = await Promise.all((await readdir(new URL("../drizzle/", import.meta.url)))
  .filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
  .map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")));

async function fixture() {
  const { default: ts } = await import("typescript");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of migrations) db.exec(sql);
  db.exec(`INSERT INTO students(id,display_name,degree,grade_year,stage,active) VALUES
      ('s1','学生一','硕士',2025,'实验',1),('s2','学生二','硕士',2025,'实验',1),('s3','历史学生','硕士',2025,'实验',0);
    INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES
      (1,'student-1','学生一','student','s1'),(2,'superadmin','确认管理员','superadmin',NULL),
      (3,'assigned-admin','只读导师','admin',NULL),(4,'unassigned-admin','未分配导师','admin',NULL),
      (5,'student-2','学生二','student','s2');
    INSERT INTO mentor_student_assignments(mentor_user_id,student_id,can_review) VALUES (3,'s1',0);`);
  for (const [id, studentId, date] of [[18,"s1","2026-09-10"],[19,"s1","2026-09-11"],
    [20,"s1","2026-09-12"],[21,"s2","2026-09-12"],[22,"s3","2026-09-12"],[23,"s1","2026-09-09"]]) {
    db.prepare(`INSERT INTO progress_entries(id,student_id,kind,title,review_status,assessment,status,reviewed_by_user_id,reviewed_at)
      VALUES(?,?,'项目',?,'accepted','substantive','substantive',2,?)`).run(id, studentId, `原进展 ${id}`, `${date} 08:00:00`);
    db.prepare(`INSERT INTO project_progress_details(progress_entry_id,next_action,next_action_due_date,blocker)
      VALUES(?,'完成复测','2026-09-13','设备问题')`).run(id);
    db.prepare(`INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,review_status,assessment,reviewed_at,created_at)
      VALUES(?,1,'{}','accepted','substantive',?,?)`).run(id, `${date} 08:00:00`, `${date} 07:00:00`);
    const status = id === 19 ? "pending" : "resolved";
    const itemKind = id === 20 ? "next_action" : "blocker";
    db.prepare(`INSERT INTO progress_resolutions(id,student_id,progress_entry_id,revision_number,item_kind,source_title,source_text,
      source_due_date,track_type,status,version,submission_note,reviewer_note,submitted_by_user_id,submitted_at,resolved_at,last_request_id)
      VALUES(?,?,?,1,?,?,?,'2026-09-13','project',?,4,'复测已完成，日志已补充','确认完成',1,'2026-09-14 08:00:00',?,?)`)
      .run(id, studentId, id, itemKind, `原进展 ${id}`, id === 20 ? "完成复测" : "设备问题", status,
        status === "resolved" ? `2026-09-${id === 18 ? "15" : "16"} 09:00:00` : null, `last-${id}`);
    const history = [
      ["submit","open","pending",1,"初次说明","2026-09-13 08:00:00"],
      ["request_changes","pending","changes_requested",2,"请补充日志","2026-09-13 09:00:00"],
      ["submit","changes_requested","pending",1,"复测已完成，日志已补充","2026-09-14 08:00:00"],
      ["confirm","pending","resolved",2,"确认完成",`2026-09-${id === 18 ? "15" : "16"} 09:00:00`],
    ];
    for (const [index, [action, from, to, actor, note, date]] of history.entries()) {
      if (status === "pending" && action === "confirm") continue;
      db.prepare(`INSERT INTO progress_resolution_events(id,resolution_id,actor_user_id,action,from_status,to_status,version,note,request_id,request_hash,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,'hash',?)`).run(id * 10 + index, id, actor, action, from, to, index + 1, note, `event-${id}-${index}`, date);
    }
  }
  db.exec(`INSERT INTO progress_resolution_attachments(id,event_id,storage_key,file_name,content_type,size_bytes,content_sha256) VALUES
      (1,180,'old-evidence','初次材料.txt','text/plain',10,'old-hash'),
      (2,182,'final-evidence','复测日志.txt','text/plain',30,'final-hash');
    INSERT INTO progress_deletions(progress_entry_id,deleted_by_user_id,operation_id) VALUES(23,2,'deleted-progress');`);

  let actor = { id: 2, role: "superadmin", studentId: null };
  const queries = [];
  const adapt = (sql, args = []) => ({
    bind(...values) { return adapt(sql, values); },
    async all() {
      const results = db.prepare(sql).all(...args);
      queries.push({ sql, args, results });
      return { results, success: true };
    },
    async first() { return (await this.all()).results[0] ?? null; },
  });
  const common = {
    database: { getD1: () => ({ prepare: adapt }), ensureDatabase: async () => {} },
    "access-policy": accessPolicy,
    "query-sql": { acceptedTrackProgressSql },
    "progress-resolution": resolution,
    "progress-blocker": blocker,
    "feishu-auth": { async requireAppUser(_request, roles) {
      return roles.includes(actor.role) ? { user: actor } : { response: Response.json({ error: "无权访问" }, { status: 403 }) };
    } },
    "progress-attachments": { AttachmentInputError: class AttachmentInputError extends Error {} },
    "progress-evidence": {}, "progress-file-storage": {}, "progress-file-cleanup": {}, "progress-resolution-sql": {},
  };
  async function compile(path) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    new Function("require", "exports", compiled)((path) => {
      const name = path.split("/").pop();
      assert.ok(common[name], `Unknown dependency ${path}`);
      return common[name];
    }, exports);
    return exports;
  }
  common.authorization = await compile("../lib/authorization.ts");
  common["progress-resolution-service"] = await compile("../lib/progress-resolution-service.ts");
  const route = await compile("../app/api/progress-resolutions/route.ts");
  return { db, queries, setActor(user) { actor = user; queries.length = 0; },
    get(query = "") { return route.GET(new Request(`http://localhost/api/progress-resolutions?view=completed${query}`)); } };
}

test("completed list preserves confirmed history after new progress, including final submission and attachments", async () => {
  const app = await fixture();
  try {
    const response = await app.get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const data = await response.json();
    assert.equal(data.canReview, false);
    assert.equal(data.canSubmit, false);
    assert.deepEqual(data.items.map((item) => item.progressEntryId), [22,21,20,18]);
    assert.equal(data.items.find((item) => item.progressEntryId === 20).current, true);
    const completed = data.items.find((item) => item.progressEntryId === 18);
    assert.equal(completed.current, false);
    assert.equal(completed.status, "resolved");
    assert.equal(completed.studentName, "学生一");
    assert.equal(completed.submissionNote, "复测已完成，日志已补充");
    assert.equal(completed.submittedAt, "2026-09-14 08:00:00");
    assert.equal(completed.resolvedAt, "2026-09-15 09:00:00");
    assert.deepEqual(completed.history.map((event) => event.action), ["confirm","submit","request_changes","submit"]);
    assert.equal(completed.history.find((event) => event.action === "confirm").actorName, "确认管理员");
    const submission = completed.history.find((event) => event.action === "submit");
    assert.equal(submission.actorName, "学生一");
    assert.equal(submission.createdAt, completed.submittedAt);
    assert.deepEqual(submission.attachments, [{ id: 2, fileName: "复测日志.txt", sizeBytes: 30, url: "/api/progress-resolutions/files?id=2" }]);
    assert.equal(data.items.find((item) => item.studentId === "s3").current, false);
    // All students use one source, one record, one event, and one attachment query.
    assert.equal(app.queries.length, 5);
  } finally { app.db.close(); }
});

test("completed list enforces actual assignment scope before reading records, events, or files", async () => {
  const app = await fixture();
  try {
    app.setActor({ id: 3, role: "admin", studentId: null });
    const data = await (await app.get()).json();
    assert.deepEqual(data.items.map((item) => item.progressEntryId), [20,18]);
    assert.ok(data.items.every((item) => item.studentId === "s1" && item.canReview === false));
    const dataQueries = app.queries.filter((query) => /FROM progress_resolutions|FROM progress_resolution_events|FROM progress_resolution_attachments|accepted_candidates/u.test(query.sql));
    assert.equal(dataQueries.length, 4);
    assert.ok(dataQueries.every((query) => JSON.stringify(query.args) === '["s1"]'));
    assert.ok(dataQueries.flatMap((query) => query.results).every((row) => !row.student_id || row.student_id === "s1"));
    app.setActor({ id: 3, role: "admin", studentId: null });
    assert.equal((await app.get("&studentId=s2")).status, 403);
    assert.equal(app.queries.length, 1);
    app.setActor({ id: 4, role: "admin", studentId: null });
    assert.deepEqual((await (await app.get()).json()).items, []);
    assert.ok(app.queries.every((query) => !query.sql.includes("FROM progress_resolutions")));
  } finally { app.db.close(); }
});

test("students and switched student personas can only retrieve their own completed tasks", async () => {
  const app = await fixture();
  try {
    for (const actor of [{ id: 1, role: "student", studentId: "s1" },
      { id: 2, role: "student", primaryRole: "superadmin", studentId: "s1" }]) {
      app.setActor(actor);
      assert.deepEqual((await (await app.get()).json()).items.map((item) => item.studentId), ["s1","s1"]);
      app.setActor(actor);
      assert.equal((await app.get("&studentId=s2")).status, 403);
      assert.equal(app.queries.length, 0);
    }
    app.setActor({ id: 2, role: "student", studentId: null });
    assert.deepEqual((await (await app.get()).json()).items, []);
  } finally { app.db.close(); }
});

test("reopened and superseded unfinished records never appear as completed", async () => {
  const app = await fixture();
  try {
    app.db.exec("UPDATE progress_resolutions SET status='open',resolved_at=NULL,version=5 WHERE id=18");
    const data = await (await app.get("&studentId=s1")).json();
    assert.deepEqual(data.items.map((item) => item.progressEntryId), [20]);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM progress_resolution_events WHERE resolution_id=18 AND action='confirm'").get().n, 1);
    assert.equal(app.db.prepare("SELECT status FROM progress_resolutions WHERE id=19").get().status, "pending");
  } finally { app.db.close(); }
});

test("completed cohort lookup batches more than 100 students and sorts completion dates across batches", async () => {
  const app = await fixture();
  try {
    for (let index = 1; index <= 101; index++) {
      const studentId = `cohort-${String(index).padStart(3, "0")}`;
      app.db.prepare("INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES(?,?,'硕士',2025,'实验')")
        .run(studentId, `学生 ${index}`);
      app.db.prepare("INSERT INTO mentor_student_assignments(mentor_user_id,student_id,can_review) VALUES(3,?,0)").run(studentId);
      if (index !== 1 && index !== 101) continue;
      const entryId = index + 1000;
      const resolvedAt = index === 1 ? "2026-09-18 09:00:00" : "2026-09-20T08:00:00+08:00";
      app.db.prepare(`INSERT INTO progress_entries(id,student_id,kind,title,review_status,assessment,status,reviewed_by_user_id,reviewed_at)
        VALUES(?,?,'项目','跨批完成事项','accepted','substantive','substantive',2,'2026-09-12 08:00:00')`).run(entryId, studentId);
      app.db.prepare(`INSERT INTO project_progress_details(progress_entry_id,next_action,next_action_due_date,blocker)
        VALUES(?,'完成复测','2026-09-13','设备问题')`).run(entryId);
      app.db.prepare(`INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,review_status,assessment,reviewed_at,created_at)
        VALUES(?,1,'{}','accepted','substantive','2026-09-12 08:00:00','2026-09-12 07:00:00')`).run(entryId);
      app.db.prepare(`INSERT INTO progress_resolutions(student_id,progress_entry_id,revision_number,item_kind,source_title,source_text,
        track_type,status,version,submission_note,submitted_at,resolved_at,last_request_id)
        VALUES(?,?,1,'blocker','跨批完成事项','设备问题','project','resolved',2,'已复测','2026-09-14 08:00:00',?,?)`)
        .run(studentId, entryId, resolvedAt, `cohort-complete-${index}`);
    }
    const superadminData = await (await app.get()).json();
    assert.deepEqual(superadminData.items.map((item) => item.progressEntryId), [1101,1001,22,21,20,18]);
    assert.equal(app.queries.length, 9);
    assert.ok(app.queries.every((query) => query.args.length <= 100));
    app.setActor({ id: 3, role: "admin", studentId: null });
    const adminData = await (await app.get()).json();
    assert.deepEqual(adminData.items.map((item) => item.progressEntryId), [1101,1001,20,18]);
    assert.equal(app.queries.length, 11);
    assert.ok(app.queries.every((query) => query.args.length <= 100));
    assert.ok(adminData.items.every((item) => item.studentId !== "s2" && item.studentId !== "s3"));
  } finally { app.db.close(); }
});


test("completed tasks preserve a mentor-only confirmation without inventing a student result", async () => {
  const app = await fixture();
  try {
    app.db.exec(`DELETE FROM progress_resolution_events WHERE resolution_id=20;
      UPDATE progress_resolutions SET version=1,submission_note='',submitted_by_user_id=NULL,submitted_at=NULL,reviewer_note='导师已核对图表与修改稿' WHERE id=20;
      INSERT INTO progress_resolution_events(resolution_id,actor_user_id,action,from_status,to_status,version,note,request_id,request_hash)
        VALUES(20,2,'confirm','open','resolved',1,'导师已核对图表与修改稿','direct-confirm-20','hash');`);
    const data = await (await app.get()).json();
    const item = data.items.find(item => item.progressEntryId === 20);
    assert.equal(item.status, "resolved"); assert.equal(item.submittedAt, null); assert.equal(item.submissionNote, "");
    assert.equal(item.reviewerNote, "导师已核对图表与修改稿");
    assert.equal(item.history.length, 1); assert.equal(item.history[0].action, "confirm");
    assert.equal(item.history[0].actorName, "确认管理员"); assert.equal(item.history[0].note, item.reviewerNote);
  } finally { app.db.close(); }
});
