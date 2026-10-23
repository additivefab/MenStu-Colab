import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as accessPolicy from "../lib/access-policy.ts";
import * as problemRecords from "../lib/problem-records.ts";
import * as problemRecordsService from "../lib/problem-records-service.ts";

const migrations = await Promise.all((await readdir(new URL("../drizzle/", import.meta.url)))
  .filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
  .map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")));

async function fixture() {
  const { default: ts } = await import("typescript");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of migrations) db.exec(sql);
  db.exec(`INSERT INTO students(id,display_name,degree,grade_year,stage,active) VALUES
      ('s1','学生一','硕士',2025,'实验',1),('s2','学生二','硕士',2025,'实验',1),('s3','停用学生','硕士',2025,'实验',0);
    INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES
      (1,'student','学生一','student','s1'),(2,'superadmin','管理员','superadmin',NULL),
      (3,'assigned-admin','日常指导导师','admin',NULL),(4,'unassigned-admin','未分配导师','admin',NULL);
    INSERT INTO mentor_student_assignments(mentor_user_id,student_id,can_review) VALUES (3,'s1',0),(3,'s3',1);
    INSERT INTO research_proposals(id,student_id,title,status,created_by_user_id) VALUES
      (1,'s1','研究方案一','approved',2),(2,'s2','研究方案二','submitted',2);
    INSERT INTO research_milestones(id,proposal_id,title,evidence_target,status,archived_at,target_date) VALUES
      (1,1,'设备调试','稳定运行','blocked',NULL,'2026-10-25'),(2,1,'旧版节点','旧标准','blocked','2026-09-01','2026-10-25'),
      (3,1,'已完成节点','已达标','completed',NULL,'2026-10-25'),(4,2,'未采纳方案节点','不应显示','blocked',NULL,'2026-10-25');
    INSERT INTO student_papers(id,student_id,title,status,created_by_user_id) VALUES
      (1,'s1','有效论文','active',2),(2,'s1','已关闭论文','closed',2);`);
  for (const [id, studentId, date, paperId] of [[10,"s1","2026-09-10",null],[11,"s1","2026-09-11",null],
    [12,"s1","2026-09-12",1],[13,"s1","2026-09-13",2],[14,"s1","2026-09-14",null],
    [20,"s2","2026-09-12",null],[30,"s3","2026-09-12",null]]) {
    db.prepare(`INSERT INTO progress_entries(id,student_id,kind,title,review_status,assessment,status,reviewed_by_user_id,reviewed_at)
      VALUES(?,?,?,?,'accepted','substantive','substantive',2,?)`).run(id, studentId, paperId ? "论文" : "项目", `原进展 ${id}`, `${date} 08:00:00`);
    if (paperId) db.prepare(`INSERT INTO paper_progress_details(progress_entry_id,paper_id,stage,next_action,next_action_due_date,blocker)
      VALUES(?,?,'drafting','完成下一步','2026-10-25','论文问题')`).run(id,paperId);
    else db.prepare(`INSERT INTO project_progress_details(progress_entry_id,next_action,next_action_due_date,blocker)
      VALUES(?,'完成下一步','2026-10-25','课题问题')`).run(id);
    db.prepare(`INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,review_status,assessment,reviewed_at,created_at)
      VALUES(?,1,'{}','accepted','substantive',?,?)`).run(id, `${date} 08:00:00`, `${date} 07:00:00`);
  }
  for (const [entryId, kind, status] of [[10,"blocker","pending"],[11,"blocker","changes_requested"],
    [12,"blocker","resolved"],[11,"next_action","pending"],[14,"blocker","resolved"]]) {
    db.prepare(`INSERT INTO progress_resolutions(student_id,progress_entry_id,revision_number,item_kind,
      source_title,source_text,track_type,status,last_request_id,updated_at)
      VALUES('s1',?,1,?,?,?,'project',?,?,'2026-10-20 08:00:00')`)
      .run(entryId,kind,`旧标题 ${entryId}`,kind === "blocker" ? "问题原文" : "不要收录计划",status,`req-${entryId}-${kind}`);
  }
  db.exec(`INSERT INTO progress_deletions(progress_entry_id,deleted_by_user_id,operation_id) VALUES(14,2,'deleted-progress');
    INSERT INTO student_guidance_notes(id,student_id,mentor_user_id,guidance_type,title,content,status,verification_mode,student_reported_at) VALUES
      (1,'s1',3,'blocker','补充设备','缺少设备','open','self_report',NULL),
      (2,'s1',3,'blocker','采购完成','设备已到位','completed','self_report',NULL),
      (3,'s1',3,'blocker','实验环境','环境已经配置','open','mentor_verify','2026-10-21'),
      (4,'s1',3,'general','日常建议','不要放进问题记录','open','self_report',NULL),
      (5,'s2',2,'blocker','其他学生的问题','不可跨权限读取','open','self_report',NULL),
      (6,'s3',2,'blocker','停用档案','不可显示','open','self_report',NULL);`);
  let actor = { id: 2, role: "superadmin", studentId: null };
  const queries = [];
  const adapt = (sql, args = []) => ({
    bind(...values) { return adapt(sql, values); },
    async all() {
      assert.ok(args.length <= 90, `query exceeds binding budget: ${args.length}`);
      const results = db.prepare(sql).all(...args);
      queries.push({ sql, args, results });
      return { results, success: true };
    },
    async first() { return (await this.all()).results[0] ?? null; },
  });
  const common = {
    database: { getD1: () => ({ prepare: adapt }), ensureDatabase: async () => {} },
    "access-policy": accessPolicy,
    "problem-records": problemRecords,
    "problem-records-service": problemRecordsService,
    "feishu-auth": { async requireAppUser(_request, roles) {
      return roles.includes(actor.role) ? { user: actor } : { response: Response.json({ error: "无权访问" }, { status: 403 }) };
    } },
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
  const route = await compile("../app/api/problem-records/route.ts");
  return { db, queries, setActor(user) { actor = user; queries.length = 0; },
    get(query = "") { return route.GET(new Request(`http://localhost/api/problem-records${query}`)); } };
}

test("problem ledger deduplicates resolutions and retains old problems until explicitly resolved", async () => {
  const app = await fixture();
  try {
    const response = await app.get();
    assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"private, no-store");
    assert.equal(response.headers.get("vary"),"Cookie");
    const data = await response.json();
    const records = new Map(data.records.map((record) => [record.id,record]));
    assert.equal(records.size,data.records.length);
    assert.deepEqual(data.students.map((student) => student.id).sort(),["s1","s2"]);
    assert.equal(records.get("progress:11:1:blocker").status,"changes_requested");
    assert.equal(records.get("progress:11:1:blocker").title,"原进展 11");
    assert.equal(records.get("progress:11:1:blocker").current,true);
    assert.equal(records.get("progress:10:1:blocker").status,"pending");
    assert.equal(records.get("progress:10:1:blocker").originalStatus,"pending");
    assert.equal(records.get("progress:10:1:blocker").current,true);
    assert.equal(records.get("progress:10:1:blocker").href,"/students/s1#progress-resolution-10-blocker-revision-1");
    assert.equal(records.get("progress:12:1:blocker").status,"resolved");
    assert.ok(records.has("progress:20:1:blocker"));
    assert.equal(records.get("guidance:2").status,"resolved");
    assert.equal(records.get("guidance:3").status,"pending");
    assert.equal(records.get("milestone:1").dueDate,"2026-10-25");
    assert.equal(records.get("progress:13:1:blocker").status,"open","closed papers do not silently resolve a recorded problem");
    for (const excluded of ["progress:14:1:blocker","progress:30:1:blocker",
      "milestone:2","milestone:3","milestone:4","guidance:4","guidance:6"]) assert.ok(!records.has(excluded),excluded);
    assert.ok(!data.records.some((record) => record.content === "不要收录计划"));
    assert.ok(!data.records.some((record) => "attachments" in record || "history" in record));
    assert.ok(!app.queries.some(({sql}) => /FROM (progress_resolution_events|progress_resolution_attachments)/.test(sql)));
    assert.equal(app.queries.length,5,"one student query and four batched source queries");
  } finally { app.db.close(); }
});

test("problem ledger enforces assigned student scope, rejects student users and matches daily recording authority", async () => {
  const app = await fixture();
  try {
    app.setActor({id:3,role:"admin",studentId:null});
    const assigned = await (await app.get("?studentId=s2&view=all")).json();
    assert.deepEqual(assigned.students,[{id:"s1",name:"学生一",stage:"实验",canRecord:true}]);
    assert.ok(assigned.records.length > 0);
    assert.ok(assigned.records.every((record) => record.studentId === "s1"));
    app.setActor({id:3,role:"admin",studentId:"s1"});
    assert.equal((await (await app.get()).json()).students[0].canRecord,false);
    app.setActor({id:4,role:"admin",studentId:null});
    const empty = await (await app.get()).json();
    assert.deepEqual(empty.students,[]);
    assert.deepEqual(empty.records,[]);
    assert.equal(app.queries.length,1,"unassigned mentor only loads assignment scope");
    app.setActor({id:1,role:"student",studentId:"s1"});
    assert.equal((await app.get()).status,403);
    assert.equal(app.queries.length,0);
  } finally { app.db.close(); }
});

test("closed tracks and revised sources retain independently recorded problems", async () => {
  const app = await fixture();
  try {
    app.db.exec(`UPDATE student_papers SET status='closed' WHERE id=1;
      UPDATE progress_entries SET review_status='submitted' WHERE id=11;
      UPDATE progress_revisions SET review_status='submitted' WHERE progress_entry_id=11;`);
    const {records} = await (await app.get()).json();
    const historical = records.find((record) => record.id === "progress:11:1:blocker");
    assert.equal(historical.current,true);
    assert.equal(historical.status,"changes_requested");
    assert.equal(historical.originalStatus,"changes_requested");
    const completed = records.find((record) => record.id === "progress:12:1:blocker");
    assert.equal(completed.current,true);
    assert.equal(completed.status,"resolved");
    assert.ok(records.some((record) => record.source === "progress" && record.studentId === "s1" && record.current));
  } finally { app.db.close(); }
});

test("problem ledger retains an unprocessed confirmed problem after another submission without creating duplicate guidance", async () => {
  const app = await fixture();
  try {
    app.db.exec(`DELETE FROM progress_resolutions WHERE progress_entry_id=10;
      UPDATE progress_entries SET review_status='submitted' WHERE id=11;
      UPDATE progress_revisions SET review_status='submitted' WHERE progress_entry_id=11;`);
    const before = app.db.prepare("SELECT COUNT(*) n FROM student_guidance_notes").get().n;
    const { records } = await (await app.get()).json();
    const problem = records.find(record => record.id === "progress:10:1:blocker");
    assert.equal(problem.current, true);
    assert.equal(problem.status, "open");
    assert.equal(problem.content, "课题问题");
    assert.equal(problem.title, "原进展 10");
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM student_guidance_notes").get().n, before);
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM progress_resolutions WHERE progress_entry_id=10").get().n, 0,
      "reading a problem does not invent a completion or submission event");
  } finally { app.db.close(); }
});

test("large mentor scopes use bounded batches instead of one query per student", async () => {
  const app = await fixture();
  try {
    const insertStudent = app.db.prepare("INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES(?,?,'硕士',2025,'实验')");
    const assign = app.db.prepare("INSERT INTO mentor_student_assignments(mentor_user_id,student_id,can_review) VALUES(3,?,0)");
    const insertNote = app.db.prepare("INSERT INTO student_guidance_notes(student_id,mentor_user_id,guidance_type,content) VALUES(?,3,'blocker','批量问题')");
    for(let index=0;index<185;index++) {
      const id = `bulk-${index}`;
      insertStudent.run(id,`批量学生 ${index}`); assign.run(id); insertNote.run(id);
    }
    app.setActor({id:3,role:"admin",studentId:null});
    const response = await app.get();
    assert.equal(response.status,200);
    const data = await response.json();
    assert.equal(data.students.length,186);
    assert.equal(data.records.filter((record) => record.studentId.startsWith("bulk-")).length,185);
    assert.equal(app.queries.length,1 + 3 + 4 * 3);
    assert.ok(app.queries.every(({args}) => args.length <= 90));
  } finally { app.db.close(); }
});
