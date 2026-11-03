import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// All sessions and research records are isolated fixtures. The initial binding
// uses the owner-confirmed ID/name pair to exercise the real provisioning path.
test("repository bindings enforce student scope, retain revisions, and stay independent of monthly work", { timeout: 120_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  let outbound = 0;
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")]
      .map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "student-repositories-fixture" },
    r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  const origin = "http://localhost";
  const cookie = (actor, persona) => actor ? `tanyan_session=repo-${actor}; tanyan_persona=${persona ?? (["student", "other", "shao"].includes(actor) ? "student" : "management")}` : "";
  const get = (studentId, actor = "owner", persona) => mf.dispatchFetch(`${origin}/api/student-repositories?studentId=${encodeURIComponent(studentId)}`, {
    headers: { cookie: cookie(actor, persona) },
  });
  const mutate = (method, body, actor = "student", extra = {}) => mf.dispatchFetch(origin + "/api/student-repositories", {
    method,
    headers: { "content-type": "application/json", origin, cookie: cookie(actor), ...extra },
    body: JSON.stringify(body),
  });
  const expectJson = async (response, expected = 200) => {
    assert.equal(response.status, expected, await response.clone().text());
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    return response.json();
  };
  const body = (expectedVersion = 0, overrides = {}) => ({
    studentId: "repo-a", githubUsername: "fixture-student",
    repositoryUrl: "https://github.com/tanyan-research-lab/synthetic-study",
    visibility: "private", expectedVersion, ...overrides,
  });
  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('repo-a', '仓库测试甲', '博士', 2025, '实验', 1),
      ('repo-b', '仓库测试乙', '硕士', 2025, '实验', 1),
      ('repo-c', '双身份测试', '博士', 2024, '实验', 1),
      ('repo-inactive', '停用测试', '硕士', 2025, '实验', 0),
      ('student-010', '邵华阳', '博士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (951, 'repo-student-user', '仓库测试甲', 'student', 'repo-a'),
      (952, 'repo-other-user', '仓库测试乙', 'student', 'repo-b'),
      (953, 'repo-owner-user', '双身份测试', 'superadmin', 'repo-c'),
      (954, 'repo-mentor-user', '范围导师', 'mentor', NULL),
      (955, 'repo-outsider-user', '其他导师', 'mentor', NULL),
      (956, 'repo-pending-user', '待授权账号', 'pending', NULL),
      (957, 'repo-shao-user', '邵华阳', 'student', 'student-010')`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (954, 'repo-a', 0, 1), (954, 'student-010', 1, 1), (954, 'repo-b', 1, 0)`).run();
    for (const [id, actor] of [[951, "student"], [952, "other"], [953, "owner"], [954, "mentor"], [955, "outsider"], [956, "pending"], [957, "shao"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`repo-${actor}`), id).run();
    }
    await db.prepare(`INSERT INTO progress_entries(id, student_id, kind, title, summary, evidence,
      status, review_status, assessment, submitted_by_user_id, reviewed_by_user_id, reviewed_at)
      VALUES (951, 'repo-a', '项目', '已确认的真实工作', '已完成测量', '实验记录',
        'substantive', 'accepted', 'substantive', 951, 953, CURRENT_TIMESTAMP)`).run();
    await db.prepare(`INSERT INTO progress_revisions(progress_entry_id, revision_number, snapshot_json,
      submitted_by_user_id, review_status, assessment, reviewed_at)
      VALUES (951, 1, '{}', 951, 'accepted', 'substantive', CURRENT_TIMESTAMP)`).run();
    await db.prepare(`INSERT INTO project_progress_details(progress_entry_id, next_action, next_action_due_date, blocker)
      VALUES (951, '后续实验', '2099-12-31', '独立待解决问题')`).run();
    await db.prepare(`INSERT INTO student_guidance_notes(student_id, mentor_user_id, title, content, next_action, due_date)
      VALUES ('repo-a', 953, '后续工作', '后续指导', '完成下一组实验', '2099-11-01')`).run();
    const businessSnapshot = async () => {
      const tables = ["students", "progress_entries", "progress_revisions", "progress_audit_events", "project_progress_details", "student_guidance_notes", "student_guidance_events", "progress_resolutions", "notification_deliveries"];
      return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results])));
    };
    const monthly = async () => {
      const response = await mf.dispatchFetch(`${origin}/api/dashboard?studentId=repo-a`, { headers: { cookie: cookie("student") } });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).students[0].monthlyDelivery;
    };

    await t.test("the confirmed private repository is provisioned exactly once without progress submission", async () => {
      const before = await businessSnapshot();
      const data = await expectJson(await get("student-010", "shao"));
      assert.equal(data.currentVersion, 1);
      assert.equal(data.canManage, true);
      assert.deepEqual({ ...data.binding, updatedAt: undefined }, {
        studentId: "student-010", githubUsername: "lih62876-ui",
        repositoryUrl: "https://github.com/tanyan-research-lab/shaohuayang-research",
        repositoryFullName: "tanyan-research-lab/shaohuayang-research", visibility: "private",
        version: 1, updatedAt: undefined,
      });
      assert.ok(data.binding.updatedAt);
      assert.deepEqual(await businessSnapshot(), before);
      assert.equal((await db.prepare("SELECT version FROM app_schema_meta WHERE id=1").first()).version, 26);
      for (let i = 0; i < 3; i += 1) await expectJson(await get("student-010", "owner"));
      assert.equal((await db.prepare("SELECT count(*) AS n FROM student_repository_events WHERE student_id='student-010'").first()).n, 1);
    });

    const beforeChanges = await businessSnapshot();
    const monthlyBefore = await monthly();
    assert.equal(monthlyBefore.phase, "confirmed");
    await t.test("private links are readable only by self, assigned mentors or management", async () => {
      for (const actor of ["student", "other", "outsider", "pending"]) await expectJson(await get("student-010", actor), 403);
      await expectJson(await get("student-010", null), 401);
      await expectJson(await get("student-010", "owner", "student"), 403);
      await expectJson(await get("student-010", "mentor"));
      await expectJson(await get("repo-b", "mentor"), 403);
      await expectJson(await get("repo-inactive", "owner"), 404);
      await expectJson(await get("does-not-exist", "owner"), 404);
      await expectJson(await get("", "owner"), 400);
      const empty = await expectJson(await get("repo-a", "student"));
      assert.deepEqual(empty, { binding: null, currentVersion: 0, canManage: true });
    });

    await t.test("unauthorized mutations and cross-origin requests never store a link or event", async () => {
      const eventCount = (await db.prepare("SELECT count(*) AS n FROM student_repository_events").first()).n;
      for (const actor of ["other", "outsider", "pending"]) await expectJson(await mutate("PUT", body(), actor), 403);
      await expectJson(await mutate("PUT", body(), null), 401);
      await expectJson(await mutate("PUT", body(), "student", { origin: "https://untrusted.example" }), 403);
      await expectJson(await mutate("DELETE", { studentId: "student-010", expectedVersion: 1 }, "owner", { origin: "https://untrusted.example" }), 403);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM student_repository_events").first()).n, eventCount);
      assert.equal((await expectJson(await get("repo-a", "student"))).binding, null);
    });

    await t.test("invalid repository URLs, accounts and versions are rejected without network access", async () => {
      const urls = [
        "http://github.com/org/repo", "https://github.com.evil.example/org/repo",
        "https://gitlab.com/org/repo", "https://user:password@github.com/org/repo",
        "https://github.com:444/org/repo", "https://github.com/org/repo?token=abc",
        "https://github.com/org/repo#readme", "https://github.com/org/repo/commit/abcdef",
        "https://github.com/org/repo/tree/main", "https://github.com/org", "https://github.com/org/re%2Fpo",
        "https://github.com/org/../repo", "https://github.com/org/%2e%2e/repo",
        "https://github.com/org\\repo", "https://github.com/org/répo", "https://github.com/org/re\npo",
      ];
      for (const repositoryUrl of urls) await expectJson(await mutate("PUT", body(0, { repositoryUrl })), 400);
      for (const githubUsername of ["", "not a user", "has_underscore", "a--b", "-start", "end-", "x".repeat(40)]) {
        await expectJson(await mutate("PUT", body(0, { githubUsername })), 400);
      }
      for (const expectedVersion of [-1, 0.5, null, "0", Number.MAX_SAFE_INTEGER + 1]) {
        await expectJson(await mutate("PUT", body(expectedVersion)), 400);
      }
      await expectJson(await mutate("PUT", body(0, { visibility: "internal" })), 400);
      assert.equal((await expectJson(await get("repo-a", "student"))).currentVersion, 0);
      assert.equal(outbound, 0, "saving a link must not call GitHub or other third parties");
    });

    await t.test("create, concurrent update and unlink retain one authoritative revision history", async () => {
      const created = await expectJson(await mutate("PUT", body(0, {
        githubUsername: " fixture-student ", repositoryUrl: "https://github.com/tanyan-research-lab/synthetic-study.git/",
      })));
      assert.equal(created.currentVersion, 1);
      assert.equal(created.binding.githubUsername, "fixture-student");
      assert.equal(created.binding.repositoryUrl, body().repositoryUrl);
      assert.equal(created.binding.repositoryFullName, "tanyan-research-lab/synthetic-study");
      const edits = await Promise.all([
        mutate("PUT", body(1, { repositoryUrl: "https://github.com/tanyan-research-lab/revision-a" }), "student"),
        mutate("PUT", body(1, { repositoryUrl: "https://github.com/tanyan-research-lab/revision-b" }), "mentor"),
      ]);
      assert.deepEqual(edits.map((response) => response.status).sort(), [200, 409]);
      for (const response of edits) await response.text();
      const edited = await expectJson(await get("repo-a", "mentor"));
      assert.equal(edited.currentVersion, 2);
      assert.match(edited.binding.repositoryUrl, /revision-[ab]$/);
      await expectJson(await mutate("DELETE", { studentId: "repo-a", expectedVersion: 1 }), 409);
      const unlinked = await expectJson(await mutate("DELETE", { studentId: "repo-a", expectedVersion: 2 }, "mentor"));
      assert.deepEqual(unlinked, { binding: null, currentVersion: 3, canManage: true });
      await expectJson(await mutate("PUT", body(0)), 409);
      await expectJson(await mutate("PUT", body(2)), 409);
      await expectJson(await mutate("DELETE", { studentId: "repo-a", expectedVersion: 2 }), 409);
      const rebound = await expectJson(await mutate("PUT", body(3, { visibility: "unknown" }), "mentor"));
      assert.equal(rebound.currentVersion, 4);
      assert.equal(rebound.binding.visibility, "unknown");
      const events = (await db.prepare("SELECT version, action, actor_user_id FROM student_repository_events WHERE student_id='repo-a' ORDER BY version").all()).results;
      assert.deepEqual(events.map((event) => event.version), [1, 2, 3, 4]);
      assert.equal(events[0].actor_user_id, 951);
      assert.equal(events[2].actor_user_id, 954);
      assert.equal(events[3].actor_user_id, 954);
    });

    await t.test("binding changes never alter progress, monthly confirmation, open problems or follow-up deadlines", async () => {
      assert.deepEqual(await businessSnapshot(), beforeChanges);
      assert.deepEqual(await monthly(), monthlyBefore);
      assert.equal(outbound, 0);
    });
  } finally {
    await mf.dispose();
  }
});

test("repository tables require deployment migrations and runtime upgrades preserve version checks", { timeout: 120_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  for (const mode of ["version-24", "fresh-bootstrap"]) await t.test(mode, async () => {
    const mf = new Miniflare({
      modules: ["index.js", ...files.filter((file) => file !== "index.js")]
        .map((path) => ({ type: "ESModule", path: root + path })),
      modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: `repository-schema-${mode}` }, r2Buckets: ["FILES"],
    });
    try {
      const db = mode === "version-24" ? await applyD1Migrations(mf, { before: "0025_" }) : await mf.getD1Database("DB");
      const failed = await mf.dispatchFetch("http://localhost/api/health/ready");
      assert.equal(failed.status, 503);
      assert.equal((await failed.json()).checks.find((check) => check.id === "database")?.status, "fail");
      assert.equal((await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'student_repository_%'").first()).n, 0,
        "a request cannot create deployment-owned repository tables");
      if (mode === "version-24") {
        assert.equal((await db.prepare("SELECT version FROM app_schema_meta WHERE id=1").first()).version, 24,
          "a missing deployment migration must not advance the runtime version");
      }
      await applyD1Migrations(mf, { from: "0025_" });
      const recovered = await mf.dispatchFetch("http://localhost/api/health/ready");
      const readiness = await recovered.json();
      assert.equal(readiness.checks.find((check) => check.id === "schema")?.status, "pass", JSON.stringify(readiness));
      assert.equal((await db.prepare("SELECT version FROM app_schema_meta WHERE id=1").first()).version, 26);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM student_repository_bindings").first()).n, 0);
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    } finally { await mf.dispose(); }
  });
});
