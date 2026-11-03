import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// G7 (design pack 02 §3/§10): a progress entry or AI meeting summary can be
// quoted as a research task. The source lives in the `created` event payload;
// the task is still an unconfirmed draft. Synthetic fixtures only.
test("research tasks: quote a progress entry as a task", { timeout: 180_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")]
      .map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "research-tasks-quote-fixture" },
    r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const studentActors = new Set(["a", "b"]);
  const cookie = (actor) => `tanyan_session=rq-${actor}; tanyan_persona=${studentActors.has(actor) ? "student" : "management"}`;
  const get = (query, actor = "a") => mf.dispatchFetch(`${origin}/api/research-tasks?${query}`, { headers: { cookie: cookie(actor) } });
  const post = (body, actor = "a") => mf.dispatchFetch(`${origin}/api/research-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: cookie(actor) },
    body: JSON.stringify(body),
  });
  const expectJson = async (response, expected = 200) => {
    assert.equal(response.status, expected, await response.clone().text());
    return response.json();
  };
  const content = (overrides = {}) => ({
    title: "按纪要复现基线", researchQuestion: "纪要中提到的基线能否复现？", hypothesis: "",
    instructions: "只修改训练脚本", acceptanceCriteria: "测试通过", ...overrides,
  });
  let seq = 0;
  const create = (body, actor = "a") => post({ action: "create", studentId: "rq-a", mutationId: `quote-create-${++seq}`, ...content(), ...body }, actor);
  const createdPayload = async (taskId) => JSON.parse((await db.prepare(
    "SELECT payload_json FROM research_task_events WHERE task_id = ? AND action = 'created'").bind(taskId).first()).payload_json);
  const taskCount = async () => (await db.prepare("SELECT count(*) AS n FROM research_tasks").first()).n;
  let db;
  try {
    db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('rq-a', '引用测试甲', '博士', 2025, '实验', 1),
      ('rq-b', '引用测试乙', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (821, 'rq-a-user', '引用测试甲', 'student', 'rq-a'),
      (822, 'rq-b-user', '引用测试乙', 'student', 'rq-b'),
      (823, 'rq-reviewer-user', '审核导师', 'mentor', NULL),
      (824, 'rq-outsider-user', '其他导师', 'mentor', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (823, 'rq-a', 1, 1)`).run();
    for (const [id, actor] of [[821, "a"], [822, "b"], [823, "reviewer"], [824, "outsider"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`rq-${actor}`), id).run();
    }
    const entry = async (studentId, kind, title, revisions = 1) => {
      const id = (await db.prepare(`INSERT INTO progress_entries(student_id, kind, title, summary, current_revision)
        VALUES (?, ?, ?, '摘要', ?) RETURNING id`).bind(studentId, kind, title, revisions).first()).id;
      for (let revision = 1; revision <= revisions; revision += 1) {
        await db.prepare("INSERT INTO progress_revisions(progress_entry_id, revision_number, snapshot_json) VALUES (?, ?, ?)")
          .bind(id, revision, JSON.stringify({ title })).run();
      }
      return id;
    };
    const aiEntry = async (studentId, title) => {
      const id = await entry(studentId, "组会", title);
      await db.prepare(`INSERT INTO progress_evidence_sources(progress_entry_id, source_type, label) VALUES (?, 'feishu_minutes', '飞书智能纪要')`)
        .bind(id).run();
      return id;
    };
    const ownEntry = await entry("rq-a", "实验", "学习率扫描", 2);
    const aiSummary = await aiEntry("rq-a", "第 12 次组会纪要");
    const deletedAi = await aiEntry("rq-a", "已删除的纪要");
    await db.prepare("INSERT INTO progress_deletions(progress_entry_id, deleted_by_user_id, operation_id) VALUES (?, 823, 'rq-del-1')")
      .bind(deletedAi).run();
    const otherEntry = await entry("rq-b", "实验", "乙的进展");
    const noteA = (await db.prepare(`INSERT INTO student_guidance_notes(student_id, mentor_user_id, title, content, next_action)
      VALUES ('rq-a', 823, '下一步', '复现基线', '跑通训练') RETURNING id`).first()).id;

    let ownTaskId;
    let aiTaskId;
    await t.test("the student quotes an own progress entry; the payload records entry and current revision", async () => {
      const created = await expectJson(await create({ sourceProgressEntryId: ownEntry }));
      ownTaskId = created.task.id;
      assert.equal(created.task.status, "draft", "a quoted task is never auto-confirmed");
      assert.equal(created.task.confirmedVersion, null);
      assert.equal(created.task.sourceGuidanceNoteId, null);
      assert.deepEqual(created.task.sourceProgress, {
        entryId: ownEntry, revision: 2, title: "学习率扫描", kind: "实验", aiSummary: false, available: true,
      });
      const payload = await createdPayload(ownTaskId);
      assert.equal(payload.sourceProgressEntryId, ownEntry);
      assert.equal(payload.sourceProgressRevision, 2);
      assert.match(payload.snapshotSha256, /^[0-9a-f]{64}$/);
      const replay = await expectJson(await post({ action: "create", studentId: "rq-a", mutationId: `quote-create-${seq}`, ...content(), sourceProgressEntryId: ownEntry }));
      assert.equal(replay.replayed, true);
      assert.equal(replay.task.id, ownTaskId);
      assert.equal(replay.task.sourceProgress.entryId, ownEntry);
    });

    await t.test("a reviewer quotes an AI meeting summary at an explicit revision", async () => {
      const created = await expectJson(await create({ sourceProgressEntryId: aiSummary, sourceProgressRevision: 1 }, "reviewer"));
      aiTaskId = created.task.id;
      assert.deepEqual(created.task.sourceProgress, {
        entryId: aiSummary, revision: 1, title: "第 12 次组会纪要", kind: "组会", aiSummary: true, available: true,
      });
      const older = await expectJson(await create({ sourceProgressEntryId: ownEntry, sourceProgressRevision: 1 }, "reviewer"));
      assert.equal(older.task.sourceProgress.revision, 1);
    });

    await t.test("another student's entry, deleted AI records and bad input are rejected without creating tasks", async () => {
      const before = await taskCount();
      await expectJson(await create({ sourceProgressEntryId: otherEntry }), 404);
      await expectJson(await create({ sourceProgressEntryId: otherEntry }, "reviewer"), 404);
      const deleted = await expectJson(await create({ sourceProgressEntryId: deletedAi }, "reviewer"), 404);
      const missing = await expectJson(await create({ sourceProgressEntryId: 999_999 }), 404);
      assert.equal(deleted.error, missing.error, "deleted, foreign and missing entries look the same");
      await expectJson(await create({ sourceProgressEntryId: ownEntry, sourceProgressRevision: 9 }), 404);
      await expectJson(await create({ sourceProgressEntryId: String(ownEntry) }), 400);
      await expectJson(await create({ sourceProgressEntryId: 0 }), 400);
      await expectJson(await create({ sourceProgressEntryId: ownEntry, sourceProgressRevision: 1.5 }), 400);
      await expectJson(await create({ sourceProgressRevision: 1 }), 400);
      assert.equal(await taskCount(), before);
    });

    await t.test("scope: actors who cannot view the student cannot quote its entries", async () => {
      const before = await taskCount();
      await expectJson(await create({ sourceProgressEntryId: ownEntry }, "b"), 403);
      await expectJson(await create({ sourceProgressEntryId: ownEntry }, "outsider"), 403);
      await expectJson(await post({ action: "create", studentId: "rq-b", mutationId: "quote-b-own-1", ...content(), sourceProgressEntryId: ownEntry }, "b"), 404);
      assert.equal(await taskCount(), before);
    });

    await t.test("detail and list expose the source progress read from the created event", async () => {
      const detail = await expectJson(await get(`taskId=${aiTaskId}`, "a"));
      assert.deepEqual(detail.sourceProgress, detail.task.sourceProgress);
      assert.equal(detail.sourceProgress.aiSummary, true);
      assert.equal(detail.events[0].payload.sourceProgressEntryId, aiSummary);
      const list = await expectJson(await get("studentId=rq-a", "reviewer"));
      const byId = new Map(list.tasks.map((task) => [task.id, task]));
      assert.equal(byId.get(ownTaskId).sourceProgress.title, "学习率扫描");
      assert.equal(byId.get(aiTaskId).sourceProgress.kind, "组会");
      await expectJson(await get(`taskId=${aiTaskId}`, "b"), 404);
    });

    await t.test("a quoted AI record deleted later stays referenced but no longer reveals its title", async () => {
      await db.prepare("INSERT INTO progress_deletions(progress_entry_id, deleted_by_user_id, operation_id) VALUES (?, 823, 'rq-del-2')")
        .bind(aiSummary).run();
      const detail = await expectJson(await get(`taskId=${aiTaskId}`, "reviewer"));
      assert.deepEqual(detail.sourceProgress, { entryId: aiSummary, revision: 1, title: "", kind: "", aiSummary: false, available: false });
      await expectJson(await create({ sourceProgressEntryId: aiSummary }, "reviewer"), 404);
    });

    await t.test("guidance-sourced tasks behave as before", async () => {
      const created = await expectJson(await create({ sourceGuidanceNoteId: noteA }));
      assert.equal(created.task.sourceGuidanceNoteId, noteA);
      assert.equal(created.task.sourceProgress, null);
      const payload = await createdPayload(created.task.id);
      assert.deepEqual(Object.keys(payload).sort(), ["parentTaskId", "snapshotSha256", "sourceRunId"]);
      const detail = await expectJson(await get(`taskId=${created.task.id}`, "a"));
      assert.equal(detail.sourceProgress, null);
      assert.equal(detail.task.sourceGuidanceNoteId, noteA);
      const both = await expectJson(await create({ sourceGuidanceNoteId: noteA, sourceProgressEntryId: ownEntry }, "reviewer"));
      assert.equal(both.task.sourceGuidanceNoteId, noteA);
      assert.equal(both.task.sourceProgress.entryId, ownEntry);
      assert.equal(outbound, 0);
    });
  } finally {
    await mf.dispose();
  }
});
