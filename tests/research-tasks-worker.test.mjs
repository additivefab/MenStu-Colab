import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { taskSnapshotSha256 } from "../lib/research-loop/contracts.ts";
import { buildTaskSnapshot, parseTaskContent } from "../lib/research-loop/tasks-core.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Synthetic fixtures only: students, accounts and sessions are inserted
// directly; no request leaves the Worker (outbound is counted and refused).
test("research tasks: lifecycle, CAS, idempotency, confirm permissions and student isolation", { timeout: 180_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")]
      .map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "research-tasks-fixture" },
    r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const studentActors = new Set(["a", "b"]);
  const cookie = (actor) => actor ? `tanyan_session=rt-${actor}; tanyan_persona=${studentActors.has(actor) ? "student" : "management"}` : "";
  const get = (query, actor = "a") => mf.dispatchFetch(`${origin}/api/research-tasks?${query}`, { headers: { cookie: cookie(actor) } });
  const post = (body, actor = "a", extra = {}) => mf.dispatchFetch(`${origin}/api/research-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: cookie(actor), ...extra },
    body: JSON.stringify(body),
  });
  const expectJson = async (response, expected = 200) => {
    assert.equal(response.status, expected, await response.clone().text());
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
    return response.json();
  };
  const content = (overrides = {}) => ({
    title: "复现基线", researchQuestion: "基线模型在合成数据上的表现？", hypothesis: "调整学习率可提升 2%",
    instructions: "只修改训练脚本中的学习率调度", acceptanceCriteria: "测试通过且指标文件生成",
    allowedPaths: ["src/**"], protectedPaths: ["configs/secret.yaml"], budget: { maxAgentMinutes: 30 }, ...overrides,
  });
  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('rt-a', '任务测试甲', '博士', 2025, '实验', 1),
      ('rt-b', '任务测试乙', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (801, 'rt-a-user', '任务测试甲', 'student', 'rt-a'),
      (802, 'rt-b-user', '任务测试乙', 'student', 'rt-b'),
      (803, 'rt-reviewer-user', '审核导师', 'mentor', NULL),
      (804, 'rt-viewer-user', '只读导师', 'mentor', NULL),
      (805, 'rt-super-user', '超级管理员', 'superadmin', NULL),
      (806, 'rt-outsider-user', '其他导师', 'mentor', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (803, 'rt-a', 1, 1), (804, 'rt-a', 0, 1)`).run();
    for (const [id, actor] of [[801, "a"], [802, "b"], [803, "reviewer"], [804, "viewer"], [805, "super"], [806, "outsider"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`rt-${actor}`), id).run();
    }
    const noteA = (await db.prepare(`INSERT INTO student_guidance_notes(student_id, mentor_user_id, title, content, next_action)
      VALUES ('rt-a', 803, '下一步', '复现基线', '跑通训练') RETURNING id`).first()).id;
    const noteB = (await db.prepare(`INSERT INTO student_guidance_notes(student_id, mentor_user_id, title, content, next_action)
      VALUES ('rt-b', 803, '下一步', '乙的意见', '整理数据') RETURNING id`).first()).id;

    let taskId;
    await t.test("create validates scope, origin, content and guidance-note ownership", async () => {
      await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "create-a-0001", ...content() }, null), 401);
      await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "create-a-0001", ...content() }, "a", { origin: "https://evil.example" }), 403);
      for (const actor of ["b", "outsider"]) {
        await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: `create-x-${actor}-01`, ...content() }, actor), 403);
      }
      await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "create-a-0002", ...content({ title: "" }) }), 400);
      await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "short", ...content() }), 400);
      await expectJson(await post({ action: "create", studentId: "rt-a", ...content() }), 400);
      await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "create-a-0003", sourceGuidanceNoteId: noteB, ...content() }), 404);
      await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "create-a-0004", ...content({ allowedPaths: ["../etc"] }) }), 400);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM research_tasks").first()).n, 0);
    });

    await t.test("create is idempotent per mutationId and never replays another student's task", async () => {
      const created = await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "create-a-main", sourceGuidanceNoteId: noteA, ...content() }));
      taskId = created.task.id;
      assert.match(taskId, /^task_[0-9a-f]{32}$/);
      assert.equal(created.task.status, "draft");
      assert.equal(created.task.currentVersion, 1);
      assert.equal(created.task.confirmedVersion, null);
      assert.equal(created.task.sourceGuidanceNoteId, noteA);
      assert.equal(created.replayed, false);
      const replay = await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "create-a-main", ...content() }));
      assert.equal(replay.task.id, taskId);
      assert.equal(replay.replayed, true);
      await expectJson(await post({ action: "create", studentId: "rt-b", mutationId: "create-a-main", ...content() }, "b"), 409);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM research_tasks").first()).n, 1);
      const stored = await db.prepare("SELECT snapshot_sha256 FROM research_task_versions WHERE task_id = ? AND version = 1").bind(taskId).first();
      const expected = await taskSnapshotSha256(buildTaskSnapshot({ taskId, version: 1, studentId: "rt-a", content: parseTaskContent(content()) }));
      assert.equal(stored.snapshot_sha256, expected);
    });

    await t.test("confirm requires the owner student or a reviewer in scope and pins the version", async () => {
      await expectJson(await post({ action: "confirm", taskId, version: 1 }, "viewer"), 403);
      await expectJson(await post({ action: "confirm", taskId, version: 1 }, "b"), 404);
      await expectJson(await post({ action: "confirm", taskId, version: 2 }), 409);
      const confirmed = await expectJson(await post({ action: "confirm", taskId, version: 1, mutationId: "confirm-a-v1" }));
      assert.equal(confirmed.task.status, "confirmed");
      assert.equal(confirmed.task.confirmedVersion, 1);
      const replay = await expectJson(await post({ action: "confirm", taskId, version: 1, mutationId: "confirm-a-v1" }));
      assert.equal(replay.replayed, true);
      const version = await db.prepare("SELECT confirmed_by_user_id, confirmed_at FROM research_task_versions WHERE task_id = ? AND version = 1").bind(taskId).first();
      assert.equal(version.confirmed_by_user_id, 801);
      assert.ok(version.confirmed_at);
    });

    await t.test("revise appends an immutable draft version, keeps confirmed_version and enforces CAS", async () => {
      const revised = await expectJson(await post({ action: "revise", taskId, expectedVersion: 1, ...content({ title: "复现基线（修订）", instructions: "新的说明" }) }, "viewer"));
      assert.equal(revised.task.status, "draft");
      assert.equal(revised.task.currentVersion, 2);
      assert.equal(revised.task.confirmedVersion, 1, "in-flight attempts keep the old confirmed snapshot");
      await expectJson(await post({ action: "revise", taskId, expectedVersion: 1, ...content() }), 409);
      const race = await Promise.all([
        post({ action: "revise", taskId, expectedVersion: 2, ...content({ instructions: "并发甲" }) }),
        post({ action: "revise", taskId, expectedVersion: 2, ...content({ instructions: "并发乙" }) }, "reviewer"),
      ]);
      assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
      for (const response of race) await response.text();
      const v1 = await db.prepare("SELECT instructions, confirmed_by_user_id FROM research_task_versions WHERE task_id = ? AND version = 1").bind(taskId).first();
      assert.equal(v1.instructions, "只修改训练脚本中的学习率调度", "version rows are never rewritten");
      assert.equal(v1.confirmed_by_user_id, 801);
      const detail = await expectJson(await get(`taskId=${taskId}`, "a"));
      assert.deepEqual(detail.versions.map((version) => version.version), [1, 2, 3]);
      assert.equal(detail.versions[0].title, "复现基线");
      assert.equal(detail.versions[1].title, "复现基线（修订）");
      assert.equal(detail.task.confirmedVersion, 1);
      assert.equal(detail.permissions.canConfirm, true);
      assert.equal(detail.permissions.canStartAttempt, false);
    });

    await t.test("a reviewer confirms the latest version; stale confirms are rejected", async () => {
      await expectJson(await post({ action: "confirm", taskId, version: 2 }, "reviewer"), 409);
      const confirmed = await expectJson(await post({ action: "confirm", taskId, version: 3 }, "reviewer"));
      assert.equal(confirmed.task.confirmedVersion, 3);
      const events = (await db.prepare("SELECT version, action, actor_user_id FROM research_task_events WHERE task_id = ? ORDER BY id").bind(taskId).all()).results;
      assert.deepEqual(events.map((event) => `${event.action}@${event.version}`), ["created@1", "confirmed@1", "revised@2", "revised@3", "confirmed@3"]);
      assert.equal(events[4].actor_user_id, 803);
      const v3 = await db.prepare("SELECT confirmed_by_user_id FROM research_task_versions WHERE task_id = ? AND version = 3").bind(taskId).first();
      assert.equal(v3.confirmed_by_user_id, 803);
    });

    await t.test("T01: tasks of another student are invisible and indistinguishable from missing ones", async () => {
      await expectJson(await get("studentId=rt-a", "b"), 403);
      await expectJson(await get("studentId=rt-a", "outsider"), 403);
      const missing = await expectJson(await get("taskId=task_doesnotexist", "b"), 404);
      const foreign = await expectJson(await get(`taskId=${taskId}`, "b"), 404);
      assert.equal(missing.error, foreign.error);
      for (const action of ["revise", "confirm", "close", "cancel"]) {
        await expectJson(await post({ action, taskId, expectedVersion: 3, version: 3, ...content() }, "b"), 404);
      }
      assert.equal((await expectJson(await get("studentId=rt-a", "a"))).tasks.length, 1);
      assert.equal((await expectJson(await get("studentId=rt-a", "viewer"))).tasks.length, 1);
      assert.equal((await expectJson(await get("studentId=rt-a", "super"))).tasks.length, 1);
      assert.equal((await expectJson(await get("studentId=rt-b", "b"))).tasks.length, 0);
      await expectJson(await get("", "a"), 400);
    });

    await t.test("close requires a decider; cancel ends the task and blocks further edits", async () => {
      const draft = await expectJson(await post({ action: "create", studentId: "rt-a", mutationId: "create-a-second", ...content({ title: "临时任务" }) }));
      await expectJson(await post({ action: "close", taskId: draft.task.id }), 409, "a draft that was never confirmed cannot be closed");
      const canceled = await expectJson(await post({ action: "cancel", taskId: draft.task.id }, "viewer"));
      assert.equal(canceled.task.status, "canceled");
      await expectJson(await post({ action: "revise", taskId: draft.task.id, expectedVersion: 1, ...content() }), 409);
      await expectJson(await post({ action: "confirm", taskId: draft.task.id, version: 1 }), 409);
      await expectJson(await post({ action: "close", taskId }, "viewer"), 403);
      const closed = await expectJson(await post({ action: "close", taskId }, "a"));
      assert.equal(closed.task.status, "closed");
      assert.equal((await expectJson(await post({ action: "close", taskId }, "a"))).replayed, true);
      const actions = (await db.prepare("SELECT action FROM research_task_events WHERE task_id = ? ORDER BY id").bind(draft.task.id).all()).results.map((row) => row.action);
      assert.deepEqual(actions, ["created", "canceled"]);
      await expectJson(await post({ action: "unknown", taskId }), 400);
      assert.equal(outbound, 0);
    });
  } finally {
    await mf.dispose();
  }
});
