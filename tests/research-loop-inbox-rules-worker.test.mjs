import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Independent cross-check (batch 3, C5) of the mentor decision inbox rules in
// the header of lib/research-loop-inbox.ts, asserted only through
// GET /api/dashboard (`loopTasks`, `metrics.loopPending`). Written without
// reading the implementation: expectations come from a small reference model
// of the header rules (`expectedFor`) evaluated over the synthetic seed below.
// Everything is synthetic; outbound network is blocked.

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ITEM_KEYS = ["href", "id", "kind", "objectId", "runNumber", "studentId", "studentName", "taskId", "taskTitle",
  "taskVersion", "technicalValidity", "title", "waitingSince"].sort();
const KINDS = ["task_confirmation", "change_extra_review", "run_approval", "result_review"];
// plan_review (batch 5) deep-links to the task like the change kinds; this
// fixture seeds no plans, so KINDS above stays the four seeded kinds.
const TASK_KINDS = new Set(["task_confirmation", "change_extra_review", "plan_review"]);

// --- Actors -----------------------------------------------------------------
const STUDENTS = [
  { id: "inbox-a", name: "甲同学在册", active: 1, userId: 3001 },
  { id: "inbox-b-unassigned", name: "乙同学无导师", active: 1, userId: 3002 },
  { id: "inbox-x-inactive", name: "丙同学已停用", active: 0, userId: 3003 },
  { id: "inbox-d-revoked", name: "丁同学分配撤销", active: 1, userId: 3004 },
  { id: "inbox-e-readonly", name: "戊同学只读", active: 1, userId: 3005 },
];
const VIEWERS = {
  stuA: { id: 3001, role: "student", persona: "student" },
  mentor1: { id: 3010, role: "admin", persona: "management" },
  mentor2: { id: 3011, role: "admin", persona: "management" },
  mentorUnassigned: { id: 3012, role: "admin", persona: "management" },
  mentorReadonly: { id: 3013, role: "admin", persona: "management" },
  mentorRevoked: { id: 3014, role: "admin", persona: "management" },
  root: { id: 3020, role: "superadmin", persona: "management" },
  root2: { id: 3021, role: "superadmin", persona: "management" },
};
// [mentor, student, can_review, active]
const ASSIGNMENTS = [
  [3010, "inbox-a", 1, 1], [3010, "inbox-x-inactive", 1, 1], [3010, "inbox-d-revoked", 1, 0], [3010, "inbox-e-readonly", 0, 1],
  [3011, "inbox-a", 1, 1],
  [3013, "inbox-a", 0, 1],
  [3014, "inbox-a", 1, 0],
];

// --- Research-loop objects (each gets a distinct timestamp) -----------------
let clock = 0;
const ts = () => new Date(Date.UTC(2026, 9, 1, 0, clock++)).toISOString().replace("T", " ").slice(0, 19);
const S = (id) => STUDENTS.find((student) => student.id === id);
const tasks = [];
const changes = [];
const runs = [];
const task = (id, studentId, status, createdBy, extra = {}) => tasks.push({ id, studentId, status, createdBy, version: 1, title: `任务${id}`, ts: ts(), ...extra });
const change = (id, taskId, attemptBy, extra = {}) => changes.push({ id, taskId, attemptBy, status: "pending_review", extra: 1, approvedAt: null, ts: ts(), ...extra });
const run = (id, taskId, status, createdBy, extra = {}) => runs.push({ id, taskId, status, createdBy, result: status === "completed" ? "valid" : null, review: null, ts: ts(), ...extra });

const A = "inbox-a";
// task_confirmation candidates
task("t_a_draft_student", A, "draft", 3001);
task("t_a_draft_mentor1", A, "draft", 3010);
task("t_a_draft_root", A, "draft", 3020, { version: 2 });
task("t_a_confirmed", A, "confirmed", 3001);
task("t_a_closed", A, "closed", 3001);
task("t_a_canceled", A, "canceled", 3001);
// change_extra_review candidates (all on the confirmed task)
change("cr_a_student", "t_a_confirmed", 3001);
change("cr_a_mentor1", "t_a_confirmed", 3010);
change("cr_a_root", "t_a_confirmed", 3020);
change("cr_a_no_extra", "t_a_confirmed", 3001, { extra: 0 });
change("cr_a_approved", "t_a_confirmed", 3001, { approvedAt: "2026-09-30 00:00:00" });
change("cr_a_open", "t_a_confirmed", 3001, { status: "open" });
change("cr_a_rejected", "t_a_confirmed", 3001, { status: "rejected" });
// run_approval candidates
run("run_a_await_student", "t_a_confirmed", "awaiting_approval", 3001);
run("run_a_await_mentor1", "t_a_confirmed", "awaiting_approval", 3010);
run("run_a_await_root", "t_a_confirmed", "awaiting_approval", 3020);
run("run_a_queued", "t_a_confirmed", "queued", 3001);
run("run_a_running", "t_a_confirmed", "running", 3001);
run("run_a_failed", "t_a_confirmed", "failed", 3001);
// result_review candidates
run("run_a_done_noreview", "t_a_confirmed", "completed", 3001);
run("run_a_done_pending", "t_a_confirmed", "completed", 3001, { review: "pending" });
run("run_a_done_invalid", "t_a_confirmed", "completed", 3001, { result: "invalid", review: "pending" });
run("run_a_done_noresult", "t_a_confirmed", "completed", 3001, { result: null });
run("run_a_done_accepted", "t_a_confirmed", "completed", 3001, { review: "accepted" });
run("run_a_done_rejected", "t_a_confirmed", "completed", 3001, { review: "rejected" });
run("run_a_done_followup", "t_a_confirmed", "completed", 3001, { review: "needs_followup" });
run("run_a_done_by_mentor1", "t_a_confirmed", "completed", 3010, { review: "pending" });
// Every other student gets one open item of each kind, created by the student.
for (const student of STUDENTS.filter((item) => item.id !== A)) {
  const slug = student.id;
  task(`t_${slug}_draft`, slug, "draft", student.userId);
  task(`t_${slug}_confirmed`, slug, "confirmed", student.userId);
  change(`cr_${slug}`, `t_${slug}_confirmed`, student.userId);
  run(`run_${slug}_await`, `t_${slug}_confirmed`, "awaiting_approval", student.userId);
  run(`run_${slug}_done`, `t_${slug}_confirmed`, "completed", student.userId, { review: "pending" });
}
const taskById = new Map(tasks.map((item) => [item.id, item]));
for (const item of [...changes, ...runs]) item.studentId = taskById.get(item.taskId).studentId;

// --- Reference model of the header rules ------------------------------------
const canReview = (viewer, studentId) => {
  const student = S(studentId);
  if (!student.active) return false;
  if (viewer.role === "superadmin") return true;
  if (viewer.role !== "admin") return false;
  return ASSIGNMENTS.some(([mentor, sid, review, active]) => mentor === viewer.id && sid === studentId && review === 1 && active === 1);
};
const runNumber = (runId) => {
  const target = runs.find((item) => item.id === runId);
  const siblings = runs.filter((item) => item.taskId === target.taskId).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  return siblings.findIndex((item) => item.id === runId) + 1;
};
function expectedFor(viewer) {
  if (viewer.role === "student") return [];
  const out = [];
  for (const item of tasks) {
    if (item.status === "draft" && item.createdBy !== viewer.id && canReview(viewer, item.studentId)) {
      out.push({ kind: "task_confirmation", objectId: item.id, taskId: item.id, studentId: item.studentId, ts: item.ts, taskVersion: item.version });
    }
  }
  for (const item of changes) {
    if (item.status === "pending_review" && item.extra === 1 && !item.approvedAt && item.attemptBy !== viewer.id && canReview(viewer, item.studentId)) {
      out.push({ kind: "change_extra_review", objectId: item.id, taskId: item.taskId, studentId: item.studentId, ts: item.ts });
    }
  }
  for (const item of runs) {
    if (!canReview(viewer, item.studentId)) continue;
    if (item.status === "awaiting_approval" && item.createdBy !== viewer.id) {
      out.push({ kind: "run_approval", objectId: item.id, taskId: item.taskId, studentId: item.studentId, ts: item.ts });
    }
    // Header: result_review has no creator exclusion (see the AMBIGUOUS subtest).
    if (item.status === "completed" && (item.review === null || item.review === "pending")) {
      out.push({ kind: "result_review", objectId: item.id, taskId: item.taskId, studentId: item.studentId, ts: item.ts, validity: item.result });
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1)).slice(0, 200).map((item) => ({ ...item, id: `${item.kind}:${item.objectId}` }));
}

const toMs = (value) => {
  const text = String(value).trim().replace(" ", "T");
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(text) ? text : `${text}Z`);
};

test("research loop inbox: rules, scope, self-exclusion and shape via /api/dashboard", { timeout: 240_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "inbox-rules-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const dashboard = async (actor) => {
    const response = await mf.dispatchFetch("http://localhost/api/dashboard", {
      headers: { cookie: `tanyan_session=inbox-${actor}; tanyan_persona=${VIEWERS[actor].persona}` },
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${actor}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  try {
    const db = await applyD1Migrations(mf);
    const run1 = (sql, ...binds) => db.prepare(sql).bind(...binds).run();

    // Students, users, sessions, assignments.
    for (const student of STUDENTS) {
      await run1("INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES (?, ?, '博士', 2025, '实验', ?)",
        student.id, student.name, student.active);
      await run1("INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES (?, ?, ?, 'student', ?)",
        student.userId, `inbox-open-${student.userId}`, student.name, student.id);
    }
    for (const [actor, viewer] of Object.entries(VIEWERS)) {
      if (viewer.role !== "student") {
        await run1("INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES (?, ?, ?, ?, NULL)",
          viewer.id, `inbox-open-${viewer.id}`, `收件箱${actor}`, viewer.role === "admin" ? "mentor" : "superadmin");
      }
      await run1("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", digest(`inbox-${actor}`), viewer.id);
    }
    for (const [mentor, studentId, review, active] of ASSIGNMENTS) {
      await run1("INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES (?, ?, ?, ?)", mentor, studentId, review, active);
    }

    // Shared lab fixtures.
    await run1("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_inbox_agent', '代理', 'agent', ?)", sha256("agent-token"));
    await run1("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_inbox_compute', '计算', 'compute', ?)", sha256("compute-token"));
    await run1(`INSERT INTO registered_entrypoints(id, github_repository_id, name, argv_json, image_ref, evaluation_protocol_sha256, created_by_user_id)
      VALUES ('ep_inbox', 9001, 'train', '["python","train.py"]', ?, ?, 3020)`, `registry.lab/train@sha256:${sha256("image")}`, sha256("protocol"));
    await run1(`INSERT INTO dataset_versions(id, label, runner_id, manifest_sha256, split_manifest_sha256, egress_policy_json, created_by_user_id)
      VALUES ('ds_inbox', '合成数据', 'rnr_inbox_compute', ?, ?, '{}', 3020)`, sha256("manifest"), sha256("split"));
    const credentialUsers = new Set(changes.map((item) => item.attemptBy));
    for (const userId of credentialUsers) {
      await run1("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES (?, ?, 'codex', 'rnr_inbox_agent')", `cred_${userId}`, userId);
    }

    for (const item of tasks) {
      await run1(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id,
        create_mutation_id, last_mutation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id, item.studentId, item.title, item.status, item.version, item.status === "draft" ? null : item.version, item.createdBy,
      `create-${item.id}`, `last-${item.id}`, item.ts, item.ts);
      for (let version = 1; version <= item.version; version += 1) {
        await run1(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
          snapshot_sha256, author_user_id, created_at) VALUES (?, ?, ?, '合成问题', '合成说明', '合成标准', ?, ?, ?)`,
        item.id, version, item.title, sha256(`${item.id}-${version}`), item.createdBy, item.ts);
      }
    }
    for (const item of changes) {
      const attemptId = `att_${item.id}`;
      await run1(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
        base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id, diff_sha256, created_at, ended_at, updated_at)
        VALUES (?, ?, 1, ?, 'codex', ?, 9001, ?, ?, 'change_ready', ?, ?, ?, ?, ?, ?)`,
      attemptId, item.taskId, item.studentId, `cred_${item.attemptBy}`, sha256(`base-${item.id}`).slice(0, 40), sha256(`ctx-${item.id}`),
      `idem-${attemptId}`, item.attemptBy, sha256(`diff-${item.id}`), item.ts, item.ts, item.ts);
      await run1(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha,
        status, requires_extra_review, extra_review_approved_by_user_id, extra_review_approved_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 9001, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id, item.taskId, attemptId, item.studentId, sha256(`base-${item.id}`).slice(0, 40), `tanyan/${item.id}`, sha256(`head-${item.id}`).slice(0, 40),
      item.status, item.extra, item.approvedAt ? 3021 : null, item.approvedAt, item.ts, item.ts);
    }
    for (const item of runs) {
      const spec = sha256(`spec-${item.id}`);
      await run1(`INSERT INTO run_specs(sha256, canonical_json, task_id, task_version, student_id, github_repository_id, executed_commit_sha,
        entrypoint_id, dataset_version_id, created_by_user_id, created_at) VALUES (?, '{}', ?, 1, ?, 9001, ?, 'ep_inbox', 'ds_inbox', ?, ?)`,
      spec, item.taskId, item.studentId, sha256(`commit-${item.id}`).slice(0, 40), item.createdBy, item.ts);
      const ended = ["completed", "failed"].includes(item.status) ? item.ts : null;
      await run1(`INSERT INTO runs(id, run_spec_sha256, attempt, task_id, student_id, status, idempotency_key, submit_tag, created_by_user_id,
        created_at, queued_at, started_at, ended_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.id, spec, item.taskId, item.studentId, item.status, `idem-${item.id}`, `tanyan-${item.id}`, item.createdBy, item.ts,
      item.status === "awaiting_approval" ? null : item.ts, ["awaiting_approval", "queued"].includes(item.status) ? null : item.ts, ended, item.ts);
      if (item.status === "completed" && item.result) {
        await run1("INSERT INTO run_results(run_id, manifest_sha256, manifest_json, technical_validity, validity_notes, created_at) VALUES (?, ?, '{}', ?, '', ?)",
          item.id, sha256(`manifest-${item.id}`), item.result, item.ts);
      }
      if (item.review) {
        await run1("INSERT INTO result_reviews(run_id, state, reviewer_user_id, updated_at) VALUES (?, ?, ?, ?)",
          item.id, item.review, item.review === "pending" ? null : 3021, item.ts);
      }
    }
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, [], "seed is referentially valid");

    const responses = {};
    for (const actor of Object.keys(VIEWERS)) responses[actor] = await dashboard(actor);
    const items = (actor) => responses[actor].loopTasks ?? [];
    const ids = (actor) => items(actor).map((item) => item.id);
    const staff = Object.keys(VIEWERS).filter((actor) => VIEWERS[actor].role !== "student");
    const seededHashes = new Set();
    for (const item of [...tasks, ...changes, ...runs]) {
      for (const label of ["spec", "manifest", "diff", "ctx", "base", "head", "commit"]) {
        const value = sha256(`${label}-${item.id}`);
        seededHashes.add(value);
        seededHashes.add(value.slice(0, 40));
      }
    }

    await t.test("each staff viewer sees exactly the items the header rules select, oldest first", () => {
      for (const actor of staff) {
        assert.ok(Array.isArray(responses[actor].loopTasks), `${actor}: loopTasks is an array`);
        assert.deepEqual(ids(actor), expectedFor(VIEWERS[actor]).map((item) => item.id), `${actor}: exact item list and order`);
      }
    });

    await t.test("metrics.loopPending equals loopTasks.length for every staff viewer", () => {
      for (const actor of staff) assert.equal(responses[actor].metrics?.loopPending, items(actor).length, actor);
    });

    await t.test("task_confirmation: drafts not created by the viewer, never confirmed/closed/canceled", () => {
      const m2 = ids("mentor2");
      for (const id of ["t_a_draft_student", "t_a_draft_mentor1", "t_a_draft_root"]) assert.ok(m2.includes(`task_confirmation:${id}`), `mentor2 sees ${id}`);
      for (const actor of staff) {
        for (const id of ["t_a_confirmed", "t_a_closed", "t_a_canceled"]) assert.ok(!ids(actor).includes(`task_confirmation:${id}`), `${actor} must not see ${id}`);
        assert.ok(items(actor).every((item) => item.kind !== "task_confirmation" || taskById.get(item.objectId)?.status === "draft"), `${actor}: only drafts`);
      }
      const revised = items("mentor1").find((item) => item.id === "task_confirmation:t_a_draft_root");
      assert.equal(revised?.taskVersion, 2, "taskVersion is the draft's current version");
    });

    await t.test("change_extra_review: pending + extra review + unapproved only", () => {
      assert.ok(ids("mentor2").includes("change_extra_review:cr_a_student"));
      for (const actor of staff) {
        for (const id of ["cr_a_no_extra", "cr_a_approved", "cr_a_open", "cr_a_rejected"]) {
          assert.ok(!ids(actor).includes(`change_extra_review:${id}`), `${actor} must not see ${id}`);
        }
      }
    });

    await t.test("run_approval: awaiting approval only, never queued/running/failed/completed", () => {
      assert.ok(ids("mentor2").includes("run_approval:run_a_await_student"));
      for (const actor of staff) {
        for (const id of ["run_a_queued", "run_a_running", "run_a_failed", "run_a_done_noreview"]) {
          assert.ok(!ids(actor).includes(`run_approval:${id}`), `${actor} must not see run_approval:${id}`);
        }
      }
    });

    await t.test("result_review: completed with no review or a pending review; reviewed results excluded", () => {
      const m2 = ids("mentor2");
      for (const id of ["run_a_done_noreview", "run_a_done_pending", "run_a_done_invalid", "run_a_done_noresult"]) {
        assert.ok(m2.includes(`result_review:${id}`), `mentor2 sees result_review:${id}`);
      }
      for (const actor of staff) {
        for (const id of ["run_a_done_accepted", "run_a_done_rejected", "run_a_done_followup", "run_a_queued", "run_a_running", "run_a_failed", "run_a_await_student"]) {
          assert.ok(!ids(actor).includes(`result_review:${id}`), `${actor} must not see result_review:${id}`);
        }
      }
    });

    await t.test("technically invalid results are included and their title signals it", () => {
      const invalid = items("mentor2").find((item) => item.id === "result_review:run_a_done_invalid");
      const valid = items("mentor2").find((item) => item.id === "result_review:run_a_done_pending");
      assert.ok(invalid, "invalid result is in the inbox");
      assert.equal(invalid.technicalValidity, "invalid");
      assert.equal(valid?.technicalValidity, "valid");
      assert.match(invalid.title, /无效|不合格|未通过|invalid/i, `title signals invalidity: ${invalid.title}`);
      assert.doesNotMatch(valid.title, /无效|不合格|未通过|invalid/i, "a valid result does not claim invalidity");
      const missing = items("mentor2").find((item) => item.id === "result_review:run_a_done_noresult");
      assert.ok(missing && [null, "unknown"].includes(missing.technicalValidity), "no result row → unknown validity");
    });

    await t.test("self-exclusion: a viewer never sees their own drafts, attempts or runs (superadmin included)", () => {
      const own = {
        mentor1: ["task_confirmation:t_a_draft_mentor1", "change_extra_review:cr_a_mentor1", "run_approval:run_a_await_mentor1"],
        root: ["task_confirmation:t_a_draft_root", "change_extra_review:cr_a_root", "run_approval:run_a_await_root"],
      };
      for (const [actor, list] of Object.entries(own)) {
        for (const id of list) assert.ok(!ids(actor).includes(id), `${actor} must not see own ${id}`);
      }
      // The same objects stay visible to the other reviewers.
      for (const id of own.mentor1) assert.ok(ids("mentor2").includes(id) && ids("root").includes(id), `others see ${id}`);
      for (const id of own.root) assert.ok(ids("mentor1").includes(id) && ids("root2").includes(id), `others see ${id}`);
    });

    await t.test("AMBIGUOUS: result_review has no creator exclusion in the header (mentor1 still reviews its own completed run)", () => {
      assert.ok(ids("mentor1").includes("result_review:run_a_done_by_mentor1"));
      assert.ok(ids("mentor2").includes("result_review:run_a_done_by_mentor1"));
    });

    await t.test("scope: unassigned, read-only and revoked mentors see nothing; mentor1 sees only inbox-a", () => {
      for (const actor of ["mentorUnassigned", "mentorReadonly", "mentorRevoked"]) {
        assert.deepEqual(items(actor), [], `${actor} has no reviewable students`);
        assert.equal(responses[actor].metrics?.loopPending, 0, `${actor}: loopPending 0`);
      }
      assert.ok(items("mentor1").length > 0);
      assert.ok(items("mentor1").every((item) => item.studentId === "inbox-a"), "mentor1 only inbox-a");
    });

    await t.test("scope: inactive students are excluded for everyone; superadmin sees every active student", () => {
      for (const actor of staff) assert.ok(items(actor).every((item) => item.studentId !== "inbox-x-inactive"), `${actor} excludes inactive`);
      const seen = new Set(items("root").map((item) => item.studentId));
      assert.deepEqual([...seen].sort(), ["inbox-a", "inbox-b-unassigned", "inbox-d-revoked", "inbox-e-readonly"]);
      for (const student of ["inbox-b-unassigned", "inbox-d-revoked", "inbox-e-readonly"]) {
        assert.deepEqual(items("root").filter((item) => item.studentId === student).map((item) => item.kind).sort(), [...KINDS].sort(),
          `root sees one item of every kind for ${student}`);
      }
    });

    await t.test("students never get loop items", () => {
      const body = responses.stuA;
      assert.ok(body.loopTasks === undefined || (Array.isArray(body.loopTasks) && body.loopTasks.length === 0), "no loopTasks for a student");
      assert.ok(body.metrics?.loopPending === undefined || body.metrics.loopPending === 0, "no loopPending for a student");
    });

    await t.test("leakage: a mentor's loopTasks never mention out-of-scope students", () => {
      const forbidden = STUDENTS.filter((student) => student.id !== "inbox-a").flatMap((student) => [student.id, student.name]);
      for (const object of [...tasks, ...changes, ...runs].filter((item) => item.studentId !== "inbox-a")) forbidden.push(object.id);
      for (const actor of ["mentor1", "mentor2", "mentorUnassigned", "mentorReadonly", "mentorRevoked"]) {
        const text = JSON.stringify(items(actor));
        for (const needle of forbidden) assert.ok(!text.includes(needle), `${actor} leaks ${needle}`);
      }
    });

    await t.test("item shape: exact keys, id/href/number conventions, waitingSince, no hashes", () => {
      for (const actor of staff) {
        const expected = new Map(expectedFor(VIEWERS[actor]).map((item) => [item.id, item]));
        let previous = -Infinity;
        for (const item of items(actor)) {
          assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS, `${actor} ${item.id}: only LoopInboxItem fields`);
          assert.ok(KINDS.includes(item.kind), item.id);
          assert.equal(item.id, `${item.kind}:${item.objectId}`);
          const model = expected.get(item.id);
          assert.ok(model, `${actor}: unexpected item ${item.id}`);
          assert.equal(item.studentId, model.studentId);
          assert.equal(item.studentName, S(model.studentId).name);
          assert.equal(item.taskId, model.taskId);
          assert.equal(item.taskTitle, taskById.get(model.taskId).title);
          const fragment = TASK_KINDS.has(item.kind) ? `#research-task-${item.taskId}` : `#research-run-${item.objectId}`;
          assert.ok(typeof item.href === "string" && item.href.endsWith(fragment), `${item.id}: href ${item.href} ends with ${fragment}`);
          const path = item.href.slice(0, -fragment.length);
          assert.ok(path === "" || path === `/students/${encodeURIComponent(item.studentId)}`, `${item.id}: href path ${path}`);
          if (TASK_KINDS.has(item.kind)) assert.equal(item.runNumber, null, `${item.id}: runNumber null`);
          else assert.equal(item.runNumber, runNumber(item.objectId), `${item.id}: per-task creation-order run number`);
          assert.equal(item.taskVersion, item.kind === "task_confirmation" ? model.taskVersion : null, `${item.id}: taskVersion`);
          if (item.kind !== "result_review") assert.equal(item.technicalValidity, null, `${item.id}: technicalValidity null`);
          else if (model.validity) assert.equal(item.technicalValidity, model.validity, `${item.id}: technicalValidity`);
          assert.ok(typeof item.title === "string" && /[一-鿿]/.test(item.title), `${item.id}: Chinese title`);
          const when = toMs(item.waitingSince);
          assert.ok(Number.isFinite(when), `${item.id}: parsable waitingSince ${item.waitingSince}`);
          assert.equal(when, toMs(model.ts), `${item.id}: waitingSince is when the object started waiting`);
          assert.ok(when >= previous, `${actor}: oldest waitingSince first`);
          previous = when;
          const rest = JSON.stringify({ ...item, id: "", objectId: "", taskId: "", studentId: "" });
          assert.doesNotMatch(rest, /[0-9a-f]{40}/i, `${item.id}: no 40/64-hex strings`);
          for (const hash of seededHashes) assert.ok(!JSON.stringify(item).includes(hash), `${item.id}: leaks seeded hash`);
        }
      }
    });

    await t.test("at most 200 items, keeping the oldest", async () => {
      const statements = [];
      for (let index = 0; index < 205; index += 1) {
        const id = `t_a_bulk_${String(index).padStart(3, "0")}`;
        const item = { id, studentId: A, status: "draft", createdBy: 3001, version: 1, title: `任务${id}`, ts: ts() };
        tasks.push(item);
        taskById.set(id, item);
        statements.push(db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, created_by_user_id,
          create_mutation_id, last_mutation_id, created_at, updated_at) VALUES (?, ?, ?, 'draft', 1, 3001, ?, ?, ?, ?)`)
          .bind(id, A, item.title, `create-${id}`, `last-${id}`, item.ts, item.ts));
        statements.push(db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
          snapshot_sha256, author_user_id, created_at) VALUES (?, 1, ?, '合成问题', '合成说明', '合成标准', ?, 3001, ?)`)
          .bind(id, item.title, sha256(`${id}-1`), item.ts));
      }
      await db.batch(statements);
      const body = await dashboard("mentor2");
      assert.equal(body.loopTasks.length, 200);
      assert.equal(body.metrics.loopPending, 200);
      assert.deepEqual(body.loopTasks.map((item) => item.id), expectedFor(VIEWERS.mentor2).map((item) => item.id));
      assert.equal(outbound, 0, "no external requests");
    });
  } finally {
    await mf.dispose();
  }
});
