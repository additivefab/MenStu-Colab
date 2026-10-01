import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolutionTransition, progressResolutionKey } from "../lib/progress-resolution.ts";
import { progressResolutionSchemaStatements } from "../lib/progress-resolution-schema.ts";
import { acceptedTrackProgressSql } from "../lib/dashboard-overview/query-sql.ts";
import { insertResolutionSql, insertConfirmedResolutionSql, updateResolutionSql, insertResolutionEventSql, insertResolutionAuditSql,
  resolutionSourceGuardSql, resolutionStudentAuthoritySql, resolutionReviewerAuthoritySql,
  resolutionUploadGuardSql } from "../lib/progress-resolution-sql.ts";

const migrations = await Promise.all((await readdir(new URL("../drizzle/", import.meta.url)))
  .filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
  .map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")));
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const sql of migrations) db.exec(sql);
  db.exec(`INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES
      ('s1','学生一','硕士',2025,'实验'),('s2','学生二','硕士',2025,'实验');
    INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES
      (1,'u1','学生一','student','s1'),(2,'u2','管理员','superadmin',NULL),
      (3,'u3','只读管理员','admin',NULL),(4,'u4','审核管理员','admin',NULL),
      (5,'u5','双身份','superadmin',NULL),(6,'u6','学生二','student','s2');
    INSERT INTO mentor_student_assignments(mentor_user_id,student_id,can_review) VALUES (3,'s1',0),(4,'s1',1);
    INSERT INTO progress_entries(id,student_id,kind,title,review_status,assessment,status,submitted_by_user_id,reviewed_by_user_id,reviewed_at)
      VALUES(18,'s1','项目','处理结果原记录','accepted','substantive','substantive',1,2,'2026-09-12 08:00:00');
    INSERT INTO project_progress_details(progress_entry_id,next_action,next_action_due_date,blocker)
      VALUES(18,'完成画图','2026-09-13','缺少设备');
    INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,review_status,assessment,reviewed_at,created_at)
      VALUES(18,1,'{}','accepted','substantive','2026-09-12 08:00:00','2026-09-12 07:00:00');`);
  return db;
}
const sourceGuard = resolutionSourceGuardSql(acceptedTrackProgressSql(1));
function perform(db, { version = 0, action = "submit", kind = "blocker", actor = action === "submit" ? 1 : 2,
  request = `req-${version}-${action}-${kind}`, note = "设备问题已经解决", files = [], failAudit = false, replayHash = "hash" } = {}) {
  const row = db.prepare("SELECT * FROM progress_resolutions WHERE progress_entry_id=18 AND revision_number=1 AND item_kind=?").get(kind);
  const from = version === 0 ? "open" : row?.status ?? "open";
  const next = resolutionTransition(from, action);
  assert.ok(next, `invalid transition ${from} ${action}`);
  const submit = action === "submit";
  const authority = submit ? resolutionStudentAuthoritySql : resolutionReviewerAuthoritySql;
  const guard = `${sourceGuard} AND ${authority} AND ${resolutionUploadGuardSql(files.length)}`;
  const guardArgs = ['s1',18,1,actor,'s1',...(submit ? [] : ['s1']),...files];
  db.exec("BEGIN");
  try {
    const changed = version === 0 ? db.prepare(submit ? insertResolutionSql(guard) : insertConfirmedResolutionSql(guard)).all('s1',18,1,kind,'原记录','困难原文',
      kind === 'next_action' ? '2026-09-13' : null,'project',note,...(submit ? [actor] : []),request,...guardArgs) :
      db.prepare(updateResolutionSql(guard)).all(next,action,note,action,actor,action,action,note,next,request,
        18,1,kind,version,from,action,actor,...guardArgs);
    db.prepare(insertResolutionEventSql).all(actor,action === "resolve" ? "confirm" : action,from,note,request,replayHash,18,1,kind,request,version+1);
    if (failAudit) throw new Error("injected failure");
    db.prepare(insertResolutionAuditSql).run(actor,request,request);
    for (const key of files) {
      db.prepare(`INSERT INTO progress_resolution_attachments(event_id,storage_key,file_name,content_type,size_bytes,content_sha256)
        SELECT id, ?, 'evidence.pdf', 'application/pdf', 10, 'hash' FROM progress_resolution_events
        WHERE actor_user_id=? AND request_id=?`).run(key,actor,request);
      db.prepare(`DELETE FROM progress_file_cleanup_queue WHERE storage_key=? AND EXISTS(
        SELECT 1 FROM progress_resolution_attachments WHERE storage_key=?)`).run(key,key);
    }
    db.exec("COMMIT");
    return changed.length;
  } catch(error) { db.exec("ROLLBACK"); throw error; }
}

test("resolution state machine keeps blocker and plan independent and requires review", () => {
  assert.equal(resolutionTransition("open", "submit"), "pending");
  assert.equal(resolutionTransition("pending", "confirm"), "resolved");
  assert.equal(resolutionTransition("pending", "request_changes"), "changes_requested");
  assert.equal(resolutionTransition("changes_requested", "submit"), "pending");
  assert.equal(resolutionTransition("resolved", "reopen"), "open");
  for (const [status, action] of [["open","confirm"],["pending","submit"],["resolved","submit"],["open","reopen"]]) {
    assert.equal(resolutionTransition(status, action), null);
  }
  assert.notEqual(progressResolutionKey(18,1,"blocker"),progressResolutionKey(18,1,"next_action"));
  assert.notEqual(progressResolutionKey(18,1,"blocker"),progressResolutionKey(18,2,"blocker"));
});

test("student submission and admin confirmation preserve progress and immutable event history", () => {
  const db = fixture();
  const before = db.prepare("SELECT * FROM progress_entries WHERE id=18").get();
  assert.equal(perform(db),1);
  assert.equal(db.prepare("SELECT status FROM progress_resolutions").get().status,"pending");
  assert.equal(perform(db,{version:1,action:"request_changes",note:"请补充实验日志"}),1);
  assert.equal(perform(db,{version:2,action:"submit",note:"已补充日志"}),1);
  assert.equal(perform(db,{version:3,action:"confirm"}),1);
  assert.equal(db.prepare("SELECT status FROM progress_resolutions").get().status,"resolved");
  assert.ok(db.prepare("SELECT resolved_at FROM progress_resolutions").get().resolved_at);
  assert.equal(perform(db,{version:4,action:"reopen",note:"复测发现问题仍存在"}),1);
  const row=db.prepare("SELECT status,version,resolved_at FROM progress_resolutions").get();
  assert.deepEqual({...row},{status:"open",version:5,resolved_at:null});
  assert.deepEqual(db.prepare("SELECT action FROM progress_resolution_events ORDER BY id").all().map(x=>x.action),
    ["submit","request_changes","submit","confirm","reopen"]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_audit_events WHERE action LIKE 'resolution_%'").get().n,5);
  assert.deepEqual(db.prepare("SELECT * FROM progress_entries WHERE id=18").get(),before);
  assert.equal(db.prepare("SELECT blocker,next_action FROM project_progress_details WHERE progress_entry_id=18").get().blocker,"缺少设备");
  db.close();
});

test("closing one item leaves the other item open", () => {
  const db=fixture(); perform(db); perform(db,{kind:"next_action"}); perform(db,{version:1,action:"confirm"});
  assert.deepEqual(db.prepare("SELECT item_kind,status FROM progress_resolutions ORDER BY item_kind").all().map(x=>({...x})),
    [{item_kind:"blocker",status:"resolved"},{item_kind:"next_action",status:"pending"}]);
  db.close();
});

test("wrong student, read-only administrator and self review cannot change state or audit", () => {
  const db=fixture();
  assert.equal(perform(db,{actor:6}),0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,0);
  perform(db);
  for (const actor of [1,3]) assert.equal(perform(db,{version:1,action:"confirm",actor,request:`denied-${actor}`}),0);
  db.exec("UPDATE app_users SET student_id=NULL WHERE id=1; UPDATE app_users SET student_id='s1' WHERE id=5");
  assert.equal(perform(db,{version:1,action:"confirm",actor:5}),0);
  db.exec("UPDATE app_users SET role='superadmin',student_id=NULL WHERE id=1");
  assert.equal(perform(db,{version:1,action:"confirm",actor:1}),0);
  assert.equal(db.prepare("SELECT version FROM progress_resolutions").get().version,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,1);
  assert.equal(perform(db,{version:1,action:"confirm",actor:4}),1);
  db.close();
});

test("CAS rejects stale updates and concurrent identical requests cannot duplicate audit", () => {
  const db=fixture(); perform(db);
  assert.equal(perform(db,{version:0,kind:"blocker",request:"stale-request",action:"submit"}),0);
  // Exercise the batch predicate directly: a replay would insert a duplicate event,
  // rolling the entire batch back; the API returns the existing matching request.
  assert.throws(()=>{
    const guard=`${sourceGuard} AND ${resolutionStudentAuthoritySql} AND 1 = 1`;
    db.exec("BEGIN");
    try {
      db.prepare(insertResolutionSql(guard)).all('s1',18,1,'blocker','original','text',null,'project','note',1,'req-0-submit-blocker','s1',18,1,1,'s1');
      db.prepare(insertResolutionEventSql).all(1,'submit','open','note','req-0-submit-blocker','hash',18,1,'blocker','req-0-submit-blocker',1);
      db.exec("COMMIT");
    } catch(error) {db.exec("ROLLBACK"); throw error;}
  },/UNIQUE constraint/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_audit_events WHERE action LIKE 'resolution_%'").get().n,1);
  db.close();
});

for (const change of ["new_progress", "revision", "deleted", "student_disabled", "assignment_revoked"]) {
  test(`source/authorization guard rejects ${change} after the page was opened`, () => {
    const db=fixture();perform(db);
    if(change==='new_progress') db.exec(`INSERT INTO progress_entries(id,student_id,kind,title,review_status)
      VALUES(19,'s1','项目','后续进展','submitted');
      INSERT INTO project_progress_details(progress_entry_id,next_action,next_action_due_date) VALUES(19,'新计划','2026-10-01');
      INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,review_status,created_at)
      VALUES(19,1,'{}','submitted','2026-09-14 01:00:00');`);
    if(change==='revision') db.exec("UPDATE progress_entries SET current_revision=2 WHERE id=18");
    if(change==='deleted') db.exec("INSERT INTO progress_deletions(progress_entry_id,deleted_by_user_id,operation_id) VALUES(18,2,'delete')");
    if(change==='student_disabled') db.exec("UPDATE students SET active=0 WHERE id='s1'");
    if(change==='assignment_revoked') db.exec("UPDATE mentor_student_assignments SET can_review=0 WHERE mentor_user_id=4");
    assert.equal(perform(db,{version:1,action:"confirm",actor:change==='assignment_revoked'?4:2}),0);
    assert.equal(db.prepare("SELECT version FROM progress_resolutions").get().version,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,1);
    db.close();
  });
}

test("D1-style batch rollback preserves upload lease and cannot partially resolve an item", () => {
  const db=fixture();
  db.exec("INSERT INTO progress_file_cleanup_queue(storage_key,student_id,revision_number,reason) VALUES('r2-evidence','s1',1,'upload_intent')");
  assert.throws(()=>perform(db,{files:['r2-evidence'],failAudit:true}),/injected/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolutions").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_file_cleanup_queue").get().n,1);
  assert.equal(perform(db,{files:['r2-evidence']}),1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_file_cleanup_queue").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_attachments").get().n,1);
  db.close();
});

test("an upload claimed by cleanup cannot be finalized or produce an empty submission", () => {
  const db=fixture();
  db.exec("INSERT INTO progress_file_cleanup_queue(storage_key,student_id,revision_number,reason) VALUES('claimed','s1',1,'cleanup_claimed:janitor')");
  assert.equal(perform(db,{files:['claimed']}),0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolutions").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_attachments").get().n,0);
  db.close();
});

test("runtime schema bootstrap matches published migration and is repeatable", () => {
  const db=fixture();
  const before=db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE '%resolution%' ORDER BY name").all();
  for(const sql of progressResolutionSchemaStatements) db.exec(sql);
  for(const sql of progressResolutionSchemaStatements) db.exec(sql);
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE '%resolution%' ORDER BY name").all(),before);
  assert.equal(db.prepare("SELECT version FROM app_schema_meta WHERE id=1").get().version,24);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  db.close();
});

async function endpointFixture() {
  const { default: ts } = await import("typescript");
  const blocker = await import("../lib/progress-blocker.ts");
  const resolution = await import("../lib/progress-resolution.ts");
  const sql = await import("../lib/progress-resolution-sql.ts");
  const evidence = await import("../lib/progress-evidence.ts");
  const attachment = await import("../lib/progress-attachments.ts");
  const db=fixture();
  let actor={id:1,role:"student",studentId:"s1"};
  const objects=new Map();
  const adapt=(statement)=>({
    bind(...args) { return adapt({sql:statement.sql,args}); },
    async all() { return execute(statement); },
    async first() { return execute(statement).results[0]??null; },
    async run() { return execute(statement); },
    statement,
  });
  function execute({sql,args=[]}) {
    const results=db.prepare(sql).all(...args);
    return {results,meta:{changes:db.prepare("SELECT changes() n").get().n},success:true};
  }
  const d1={prepare(sql){return adapt({sql,args:[]});},async batch(statements){
    db.exec("BEGIN");try{const result=statements.map(x=>execute(x.statement));db.exec("COMMIT");return result;}
    catch(error){db.exec("ROLLBACK");throw error;}
  }};
  const common={
    database:{getD1:()=>d1,ensureDatabase:async()=>{}},
    "query-sql":{acceptedTrackProgressSql},
    "progress-blocker":blocker,"progress-resolution":resolution,"progress-resolution-sql":sql,
    "progress-evidence":evidence,"progress-attachments":attachment,
    "progress-file-storage":{getProgressFileBucket:()=>({
      async put(key,bytes){objects.set(key,bytes);},async delete(key){objects.delete(key);},
      async get(key){return objects.has(key)?{body:objects.get(key)}:null;},
    })},
    "progress-file-cleanup":{async deleteProgressFilesOrQueue(files){for(const file of files){objects.delete(file.storageKey);db.prepare("DELETE FROM progress_file_cleanup_queue WHERE storage_key=?").run(file.storageKey);}}},
    "feishu-auth":{async requireAppUser(_request,roles){return roles.includes(actor.role)?{user:actor}:{response:Response.json({error:"无权限"},{status:403})};},
      assertSameOrigin(request){return request.headers.get("Origin")===new URL(request.url).origin;}},
    authorization:{async canViewStudent(user,studentId){return user.role==="superadmin"||user.studentId===studentId||Boolean(db.prepare("SELECT id FROM mentor_student_assignments WHERE mentor_user_id=? AND student_id=? AND active=1").get(user.id,studentId));},
      async canReviewStudent(user,studentId){return user.studentId!==studentId&&(user.role==="superadmin"||Boolean(db.prepare("SELECT id FROM mentor_student_assignments WHERE mentor_user_id=? AND student_id=? AND active=1 AND can_review=1").get(user.id,studentId)));}},
  };
  async function compile(path) {
    const source=await readFile(new URL(path,import.meta.url),"utf8");
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};
    new Function("require","exports",compiled)((path)=>{
      const name=path.split('/').pop();assert.ok(common[name],`unknown import ${path}`);return common[name];
    },exports);
    return exports;
  }
  common["progress-resolution-service"]=await compile("../lib/progress-resolution-service.ts");
  const route=await compile("../app/api/progress-resolutions/route.ts");
  const files=await compile("../app/api/progress-resolutions/files/route.ts");
  return {db,objects,route,files,setActor(user){actor=user;}};
}
function submissionRequest({requestId="request-submit-student-0001",version=0,note="设备已归还并完成复测",withFile=true}={}) {
  const form=new FormData();
  for(const [key,value] of Object.entries({progressEntryId:18,revisionNumber:1,itemKind:"blocker",expectedVersion:version,note,requestId})) form.set(key,String(value));
  if(withFile)form.append("files",new File(["实验日志"],"处理结果.txt",{type:"text/plain"}));
  return new Request("http://localhost/api/progress-resolutions",{method:"POST",headers:{Origin:"http://localhost"},body:form});
}

test("real endpoint contract uploads evidence, replays safely, confirms and downloads with student scope", async()=>{
  const {db,objects,route,files,setActor}=await endpointFixture();
  const get=()=>route.GET(new Request("http://localhost/api/progress-resolutions?studentId=s1"));
  let data=await (await get()).json();
  assert.equal(data.canSubmit,true);assert.equal(data.items.length,2);assert.ok(data.items.every(x=>x.current&&x.version===0));
  assert.equal((await route.POST(submissionRequest())).status,200);
  data=await (await get()).json();
  let item=data.items.find(x=>x.itemKind==="blocker");
  assert.equal(item.status,"pending");assert.equal(item.history[0].attachments.length,1);
  const download=item.history[0].attachments[0].url;
  assert.equal((await route.POST(submissionRequest())).status,200);
  assert.equal(objects.size,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,1);
  assert.equal((await route.POST(submissionRequest({note:"不同内容复用请求"}))).status,400);
  setActor({id:2,role:"superadmin",studentId:null});
  const approved=await route.PATCH(new Request("http://localhost/api/progress-resolutions",{method:"PATCH",headers:{Origin:"http://localhost","Content-Type":"application/json"},
    body:JSON.stringify({progressEntryId:18,revisionNumber:1,itemKind:"blocker",expectedVersion:1,action:"confirm",note:"复测通过",requestId:"request-confirm-admin-0001"})}));
  assert.equal(approved.status,200,JSON.stringify(await approved.json()));
  data=await(await get()).json();item=data.items.find(x=>x.itemKind==="blocker");
  assert.equal(item.status,"resolved");assert.equal(item.history.length,2);assert.equal(item.history[1].attachments.length,1);
  const attached=await files.GET(new Request(`http://localhost${download}`));
  assert.equal(attached.status,200);assert.equal(await attached.text(),"实验日志");
  assert.equal(attached.headers.get("Cache-Control"),"private, no-store");
  setActor({id:6,role:"student",studentId:"s2"});
  assert.equal((await files.GET(new Request(`http://localhost${download}`))).status,403);
  assert.equal((await get()).status,403);
  assert.equal((await route.POST(submissionRequest({requestId:"request-another-student-0001"}))).status,403);
  assert.equal(objects.size,1);db.close();
});

test("real endpoint returns stale history read-only and blocks stale submissions and cross-origin mutations", async()=>{
  const {db,route,setActor}=await endpointFixture();
  assert.equal((await route.POST(submissionRequest({withFile:false}))).status,200);
  db.exec(`INSERT INTO progress_entries(id,student_id,kind,title,review_status) VALUES(19,'s1','项目','最新记录','submitted');
    INSERT INTO project_progress_details(progress_entry_id,next_action,next_action_due_date) VALUES(19,'新计划','2026-10-01');
    INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,review_status,created_at)
      VALUES(19,1,'{}','submitted','2026-09-14 01:00:00');`);
  const data=await(await route.GET(new Request("http://localhost/api/progress-resolutions?studentId=s1&entryId=18"))).json();
  assert.equal(data.items.length,1);assert.equal(data.items[0].current,false);assert.equal(data.items[0].history.length,1);
  assert.equal((await route.POST(submissionRequest({version:1,requestId:"request-stale-source-0001",withFile:false}))).status,409);
  setActor({id:2,role:"superadmin",studentId:null});
  assert.equal((await route.PATCH(new Request("http://localhost/api/progress-resolutions",{method:"PATCH",headers:{Origin:"https://another.example"},body:"{}"}))).status,403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,1);db.close();
});


test("legacy persisted mentor roles require assignment review rights and support own student persona",()=>{
  const db=fixture();
  db.exec("UPDATE app_users SET role='mentor' WHERE id IN (1,3,4)");
  assert.equal(perform(db),1);
  assert.equal(perform(db,{version:1,action:"confirm",actor:1}),0);
  assert.equal(perform(db,{version:1,action:"confirm",actor:3}),0);
  assert.equal(perform(db,{version:1,action:"confirm",actor:4}),1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,2);
  db.close();
});

test("actual handlers accept normalized admin over legacy mentor only with review assignment",async()=>{
  const {db,route,setActor}=await endpointFixture();
  db.exec("UPDATE app_users SET role='mentor' WHERE id IN (1,3,4)");
  // The effective student persona can submit even when the account stores mentor.
  assert.equal((await route.POST(submissionRequest({withFile:false}))).status,200);
  const review=(requestId)=>new Request("http://localhost/api/progress-resolutions",{method:"PATCH",headers:{Origin:"http://localhost","Content-Type":"application/json"},
    body:JSON.stringify({progressEntryId:18,revisionNumber:1,itemKind:"blocker",expectedVersion:1,action:"confirm",note:"已复核",requestId})});
  setActor({id:1,role:"admin",studentId:"s1"});
  assert.equal((await route.PATCH(review("mentor-own-denied-0001"))).status,403);
  setActor({id:3,role:"admin",studentId:null});
  assert.equal((await route.PATCH(review("mentor-readonly-denied-0001"))).status,403);
  setActor({id:4,role:"admin",studentId:null});
  assert.equal((await route.PATCH(review("mentor-review-allowed-0001"))).status,200);
  assert.equal(db.prepare("SELECT status FROM progress_resolutions").get().status,"resolved");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n,2);
  db.close();
});

function reviewRequest(overrides = {}) {
  return new Request("http://localhost/api/progress-resolutions", {
    method: "PATCH", headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ progressEntryId: 18, revisionNumber: 1, itemKind: "next_action", expectedVersion: 0,
      action: "resolve", note: "已核对修改稿，图表与文字修改均已完成", requestId: "mentor-direct-resolution-0001", ...overrides }),
  });
}

test("mentor can close an open plan with evidence, replay, reopen and reclose without a fake student submission", async () => {
  const { db, route, setActor } = await endpointFixture();
  setActor({ id: 4, role: "admin", studentId: null });
  const before = db.prepare("SELECT * FROM progress_entries WHERE id=18").get();
  assert.equal((await route.PATCH(reviewRequest({ note: "   " }))).status, 400);
  assert.equal((await route.PATCH(reviewRequest({ action: "confirm" }))).status, 409);
  const response = await route.PATCH(reviewRequest());
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal((await route.PATCH(reviewRequest())).status, 200);
  assert.equal((await route.PATCH(reviewRequest({ note: "不同依据" }))).status, 400);
  assert.equal((await route.PATCH(reviewRequest({ action: "confirm" }))).status, 400);
  assert.equal((await route.PATCH(reviewRequest({ requestId: "stale-direct-resolution-0002" }))).status, 409);
  const data = await (await route.GET(new Request("http://localhost/api/progress-resolutions?studentId=s1"))).json();
  const plan = data.items.find(item => item.itemKind === "next_action");
  assert.equal(plan.status, "resolved"); assert.equal(plan.version, 1);
  assert.equal(plan.submissionNote, ""); assert.equal(plan.submittedAt, null);
  assert.equal(plan.history.length, 1); assert.equal(plan.history[0].action, "confirm");
  assert.equal(plan.history[0].actorName, "审核管理员"); assert.equal(plan.history[0].note, plan.reviewerNote);
  assert.equal(data.items.find(item => item.itemKind === "blocker").status, "open");
  const stored = db.prepare("SELECT * FROM progress_resolutions").get();
  assert.equal(stored.submitted_by_user_id, null); assert.ok(stored.resolved_at);
  assert.deepEqual(db.prepare("SELECT action,from_status,to_status FROM progress_resolution_events").all().map(x => ({ ...x })),
    [{ action: "confirm", from_status: "open", to_status: "resolved" }]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_audit_events WHERE action='resolution_confirm'").get().n, 1);
  assert.equal((await route.PATCH(reviewRequest({ action: "reopen", expectedVersion: 1, note: "复核发现需补充图表", requestId: "mentor-direct-reopen-0002" }))).status, 200);
  assert.equal((await route.PATCH(reviewRequest({ expectedVersion: 2, requestId: "mentor-direct-reclose-0003" }))).status, 200);
  assert.equal(db.prepare("SELECT version FROM progress_resolutions").get().version, 3);
  assert.deepEqual(db.prepare("SELECT * FROM progress_entries WHERE id=18").get(), before);
  assert.equal(db.prepare("SELECT next_action FROM project_progress_details WHERE progress_entry_id=18").get().next_action, "完成画图");
  db.close();
});

test("direct mentor resolution respects roles, assignment, self-review and current source guards", async () => {
  const { db, route, setActor } = await endpointFixture();
  for (const actor of [{ id: 1, role: "student", studentId: "s1" }, { id: 3, role: "admin", studentId: null }, { id: 2, role: "superadmin", studentId: "s1" }]) {
    setActor(actor); assert.equal((await route.PATCH(reviewRequest())).status, 403);
  }
  setActor({ id: 4, role: "admin", studentId: null });
  db.exec("UPDATE app_users SET active=0 WHERE id=4");
  assert.equal((await route.PATCH(reviewRequest())).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n, 0);
  db.exec("UPDATE app_users SET active=1 WHERE id=4");
  assert.equal((await route.PATCH(reviewRequest({ revisionNumber: 2 }))).status, 409);
  db.exec("UPDATE progress_entries SET review_status='submitted' WHERE id=18");
  assert.equal((await route.PATCH(reviewRequest())).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolutions").get().n, 0);
  db.close();
});

test("direct mentor resolution preserves returned student evidence and ordinary pending confirmation", async () => {
  const { db, route, setActor } = await endpointFixture();
  assert.equal((await route.POST(submissionRequest())).status, 200);
  setActor({ id: 2, role: "superadmin", studentId: null });
  const target = { itemKind: "blocker", expectedVersion: 1 };
  assert.equal((await route.PATCH(reviewRequest(target))).status, 409);
  assert.equal((await route.PATCH(reviewRequest({ ...target, action: "request_changes", requestId: "return-student-result-0001" }))).status, 200);
  // Promotion cannot permit the original submitter to review their own result.
  db.exec("UPDATE app_users SET role='superadmin',student_id=NULL WHERE id=1");
  setActor({ id: 1, role: "superadmin", studentId: null });
  assert.equal((await route.PATCH(reviewRequest({ ...target, expectedVersion: 2 }))).status, 409);
  setActor({ id: 2, role: "superadmin", studentId: null });
  assert.equal((await route.PATCH(reviewRequest({ ...target, expectedVersion: 2 }))).status, 200);
  const data = await (await route.GET(new Request("http://localhost/api/progress-resolutions?studentId=s1"))).json();
  const item = data.items.find(item => item.itemKind === "blocker");
  assert.equal(item.status, "resolved"); assert.equal(item.history.length, 3);
  assert.equal(item.history.find(event => event.action === "submit").attachments.length, 1);
  assert.equal(item.submissionNote, "设备已归还并完成复测");
  db.close();
});

test("direct resolution guards prevent stale source, revoked assignment and audit partial commits", () => {
  for (const change of ["UPDATE mentor_student_assignments SET can_review=0 WHERE mentor_user_id=4",
    "UPDATE progress_entries SET current_revision=2 WHERE id=18", "UPDATE students SET active=0 WHERE id='s1'"]) {
    const db = fixture(); db.exec(change);
    assert.equal(perform(db, { action: "resolve", actor: 4 }), 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolution_events").get().n, 0);
    db.close();
  }
  const db = fixture();
  assert.throws(() => perform(db, { action: "resolve", failAudit: true }), /injected failure/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progress_resolutions").get().n, 0);
  db.close();
});
