import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { readinessModel } from "../lib/research-loop-readiness.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// Research-loop readiness (frontend plan F6) against the built Worker. Every
// fixture is synthetic and outbound network is blocked.
const RUNNER_TOKEN_HASH = "9".repeat(64);
const IMAGE = `registry.lab/train@sha256:${"c".repeat(64)}`;
const PAYLOAD_KEYS = [
  "activeAgentWorkers", "activeComputeRunners", "entrypoints", "githubAppConfigured", "grantedDatasets",
  "repositoryBound", "repositoryLinked", "studentId", "viewerCanConfigure", "viewerCredentialProviders",
].sort();

async function startWorker(bindings = {}) {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const state = { outbound: 0 };
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root, compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "readiness-fixture" }, r2Buckets: ["FILES"], bindings,
    outboundService: () => { state.outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
  return { mf, state };
}

const personas = { studentA: "student", studentB: "student" };
function caller(mf) {
  const origin = "http://localhost";
  return async (studentId, actor, expected = 200) => {
    const cookie = actor ? `tanyan_session=rd-${actor}; tanyan_persona=${personas[actor] ?? "management"}` : "";
    const query = studentId === null ? "" : `?studentId=${encodeURIComponent(studentId)}`;
    const response = await mf.dispatchFetch(`${origin}/api/research-loop/readiness${query}`, { headers: { cookie } });
    const text = await response.text();
    assert.equal(response.status, expected, `${actor ?? "anonymous"} → ${studentId}: ${text}`);
    assert.match(response.headers.get("cache-control") ?? "", /private/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    return JSON.parse(text);
  };
}

async function seed(db) {
  await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
    ('rd-a', '准备度甲', '博士', 2025, '实验', 1), ('rd-b', '准备度乙', '硕士', 2025, '实验', 1),
    ('rd-c', '准备度丙', '硕士', 2025, '实验', 1), ('rd-off', '已停用', '硕士', 2025, '实验', 0)`).run();
  await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
    (1201, 'rd-student-a', '准备度甲', 'student', 'rd-a'), (1202, 'rd-student-b', '准备度乙', 'student', 'rd-b'),
    (1203, 'rd-mentor-1', '导师一', 'mentor', NULL), (1204, 'rd-mentor-2', '范围外导师', 'mentor', NULL),
    (1205, 'rd-root', '超级管理员', 'superadmin', NULL), (1206, 'rd-pending', '待授权', 'pending', NULL)`).run();
  await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
    (1203, 'rd-a', 1, 1), (1203, 'rd-off', 1, 1), (1204, 'rd-b', 1, 1), (1204, 'rd-a', 1, 0)`).run();
  const actors = [[1201, "studentA"], [1202, "studentB"], [1203, "mentor1"], [1204, "mentor2"], [1205, "root"], [1206, "pending"]];
  for (const [id, actor] of actors) {
    await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
      .bind(digest(`rd-${actor}`), id).run();
  }
  const bind = (studentId, fullName, active = 1) => db.prepare(`INSERT INTO student_repository_bindings
    (student_id, github_username, repository_url, repository_full_name, visibility, active, version, last_mutation_id)
    VALUES (?, 'fixture-user', ?, ?, 'private', ?, 1, ?)`).bind(studentId, `https://github.com/${fullName}`, fullName, active, `bind-${studentId}`).run();
  await bind("rd-a", "synthetic-lab/a-secret-name");
  await bind("rd-b", "synthetic-lab/b-secret-name");
  await bind("rd-c", "synthetic-lab/c-unlinked", 0);
  await db.prepare(`INSERT INTO github_installations(installation_id, account_login, account_type, status) VALUES
    (88, 'synthetic-lab', 'Organization', 'active'), (89, 'synthetic-gone', 'Organization', 'suspended')`).run();
  // rd-a: active link; rd-b: link on a suspended installation (not usable).
  await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch) VALUES
    ('rd-a', 6001, 88, 'synthetic-lab/a-secret-name', 'main'), ('rd-b', 6002, 89, 'synthetic-lab/b-secret-name', 'main')`).run();
  await db.prepare(`INSERT INTO lab_runners(id, label, kind, token_sha256, status) VALUES
    ('rnr_agent1', '代理一号-secret-label', 'agent', ?, 'active'), ('rnr_agent2', '代理二号', 'agent', ?, 'disabled'),
    ('rnr_gpu1', 'GPU 一号', 'compute', ?, 'active'), ('rnr_gpu2', 'GPU 二号', 'compute', ?, 'active'),
    ('rnr_gpu3', 'GPU 三号', 'compute', ?, 'disabled')`)
    .bind(RUNNER_TOKEN_HASH, "8".repeat(64), "7".repeat(64), "6".repeat(64), "5".repeat(64)).run();
  // Profiles: student A has codex (active worker) + claude (disabled worker);
  // student B has deepseek; mentor1 has claude; root has none.
  await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id, active) VALUES
    ('cred_a_codex', 1201, 'codex', 'rnr_agent1', 1), ('cred_a_claude', 1201, 'claude', 'rnr_agent2', 1),
    ('cred_b_deep', 1202, 'deepseek', 'rnr_agent1', 1), ('cred_m_claude', 1203, 'claude', 'rnr_agent1', 1),
    ('cred_m_codex', 1203, 'codex', 'rnr_agent1', 0)`).run();
  await db.prepare(`INSERT INTO registered_entrypoints(id, github_repository_id, name, argv_json, image_ref, active, created_by_user_id) VALUES
    ('ep_a1', 6001, 'train', '["python","train.py"]', ?, 1, 1205), ('ep_a2', 6001, 'eval', '["python","eval.py"]', ?, 1, 1205),
    ('ep_a3', 6001, 'old', '["python","old.py"]', ?, 0, 1205), ('ep_b1', 6002, 'train', '["python","train.py"]', ?, 1, 1205)`)
    .bind(IMAGE, IMAGE, IMAGE, IMAGE).run();
  await db.prepare(`INSERT INTO dataset_versions(id, label, runner_id, manifest_sha256, egress_policy_json, active, created_by_user_id) VALUES
    ('ds_1', '合成数据一', 'rnr_gpu1', ?, '{}', 1, 1205), ('ds_2', '合成数据二', 'rnr_gpu1', ?, '{}', 1, 1205),
    ('ds_3', '停用数据', 'rnr_gpu1', ?, '{}', 0, 1205)`).bind("a".repeat(64), "b".repeat(64), "c".repeat(64)).run();
  await db.prepare(`INSERT INTO dataset_grants(dataset_version_id, student_id, granted_by_user_id, revoked_at) VALUES
    ('ds_1', 'rd-a', 1205, NULL), ('ds_2', 'rd-a', 1205, CURRENT_TIMESTAMP), ('ds_3', 'rd-a', 1205, NULL),
    ('ds_2', 'rd-b', 1205, NULL)`).run();
}

test("research-loop readiness: scope isolation, counts and no secrets", { timeout: 180_000 }, async (t) => {
  const { mf, state } = await startWorker();
  const get = caller(mf);
  try {
    const db = await applyD1Migrations(mf);
    await seed(db);

    await t.test("unauthenticated, pending and out-of-scope callers are refused", async () => {
      await get("rd-a", null, 401);
      await get("rd-a", "pending", 403);
      await get("rd-b", "studentA", 403);
      await get("rd-a", "studentB", 403);
      await get("rd-a", "mentor2", 403); // assignment inactive
      await get("rd-b", "mentor1", 403);
      await get("missing-student", "mentor1", 403);
      await get("missing-student", "root", 404);
      await get("rd-off", "mentor1", 404); // inactive student
      await get(null, "root", 400);
      await get("bad id!", "root", 400);
      const refused = await get("rd-b", "studentA", 403);
      assert.equal(typeof refused.error, "string");
      assert.ok(!JSON.stringify(refused).includes("b-secret-name"));
    });

    await t.test("student A sees exact counts and only their own providers", async () => {
      const payload = await get("rd-a", "studentA");
      assert.deepEqual(Object.keys(payload).sort(), PAYLOAD_KEYS);
      assert.deepEqual(payload, {
        studentId: "rd-a", repositoryBound: true, repositoryLinked: true, githubAppConfigured: false,
        viewerCredentialProviders: ["codex"], activeAgentWorkers: 1, activeComputeRunners: 2,
        grantedDatasets: 1, entrypoints: 2, viewerCanConfigure: false,
      });
      const model = readinessModel(payload, "student");
      assert.equal(model.ready, false);
      assert.deepEqual(model.missing.map((item) => item.key), ["github_app"]);
      assert.equal(model.canStartAgents, false);
      assert.equal(model.canRegisterRuns, false);
      assert.ok(model.items.every((item) => item.href === null), "no settings links for students");
    });

    await t.test("the provider list always belongs to the viewer, never the student", async () => {
      const mentor = await get("rd-a", "mentor1");
      assert.deepEqual(mentor.viewerCredentialProviders, ["claude"], "inactive profile excluded, student's codex not revealed");
      assert.equal(mentor.viewerCanConfigure, false);
      const root = await get("rd-a", "root");
      assert.deepEqual(root.viewerCredentialProviders, []);
      assert.equal(root.viewerCanConfigure, true);
      const rootModel = readinessModel(root, "staff");
      assert.equal(rootModel.items.find((item) => item.key === "credential_profile").href, "/?mentorView=settings#loop-admin-profiles");
      assert.equal(rootModel.items.find((item) => item.key === "credential_profile").owners[0], "超级管理员");
    });

    await t.test("a link on a suspended installation and an inactive binding do not count", async () => {
      const b = await get("rd-b", "studentB");
      assert.equal(b.repositoryBound, true);
      assert.equal(b.repositoryLinked, false);
      assert.equal(b.entrypoints, 1, "entrypoint counted by repository link status, not installation");
      assert.equal(b.grantedDatasets, 1);
      assert.deepEqual(b.viewerCredentialProviders, ["deepseek"]);
      const c = await get("rd-c", "root");
      assert.equal(c.repositoryBound, false);
      assert.equal(c.repositoryLinked, false);
      assert.equal(c.entrypoints, 0);
      assert.equal(c.grantedDatasets, 0);
      const model = readinessModel(c, "staff");
      const bound = model.missing.find((item) => item.key === "repository_bound");
      assert.deepEqual(bound.owners, ["学生", "导师"]);
      assert.ok(model.missing.some((item) => item.key === "repository_linked" && item.href === "/?mentorView=settings#loop-admin-github"));
    });

    await t.test("payloads never carry secrets or other users' profile details", async () => {
      const bodies = [await get("rd-a", "studentA"), await get("rd-a", "mentor1"), await get("rd-a", "root"), await get("rd-b", "studentB")];
      for (const body of bodies) {
        const text = JSON.stringify(body);
        for (const secret of ["secret-name", "secret-label", "token", RUNNER_TOKEN_HASH, "cred_", "rnr_", "6001", "installation", "fixture-user", "github.com"]) {
          assert.ok(!text.includes(secret), `payload leaks ${secret}: ${text}`);
        }
        assert.deepEqual(Object.keys(body).sort(), PAYLOAD_KEYS);
      }
      assert.equal(state.outbound, 0, "no external requests");
    });
  } finally {
    await mf.dispose();
  }
});

test("research-loop readiness: reports a configured GitHub App and a fully ready loop", { timeout: 120_000 }, async () => {
  const { mf, state } = await startWorker({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: "synthetic-not-a-real-key" });
  const get = caller(mf);
  try {
    const db = await applyD1Migrations(mf);
    await seed(db);
    const payload = await get("rd-a", "studentA");
    assert.equal(payload.githubAppConfigured, true);
    assert.ok(!JSON.stringify(payload).includes("synthetic-not-a-real-key") && !JSON.stringify(payload).includes("12345"));
    const model = readinessModel(payload, "student");
    assert.equal(model.ready, true);
    assert.equal(model.canStartAgents, true);
    assert.equal(model.canRegisterRuns, true);
    // The mentor viewer has a profile too; the root viewer has none, so only agents are blocked for root.
    const rootModel = readinessModel(await get("rd-a", "root"), "staff");
    assert.deepEqual(rootModel.missing.map((item) => item.key), ["credential_profile"]);
    assert.equal(rootModel.canStartAgents, false);
    assert.equal(rootModel.canRegisterRuns, true);
    assert.equal(state.outbound, 0);
  } finally {
    await mf.dispose();
  }
});
