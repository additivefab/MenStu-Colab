import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { issueRunnerToken } from "../lib/lab-runner-auth.ts";
import { digest } from "../lib/local-password.ts";
import { sha256Hex } from "../lib/research-loop/contracts.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// FB2 plan-first agent attempts (docs/科研闭环_实施规格_v1.md §6.1, §12).
// Synthetic fixtures only. A minimal GitHub double (Miniflare outboundService)
// answers the two calls `start` needs (repository token + branch ref) so
// attempts are created through the API, including the plan row in the same
// batch. Any other outbound request fails the test.
test("plan-first agent attempts: plan → approve → edit, reject, self-approval, mode checks, fencing and CAS", { timeout: 240_000 }, async (t) => {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  const baseSha = "b".repeat(40);
  const unexpected = [];
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const mf = new Miniflare({
    modules: ["index.js", ...files.filter((file) => file !== "index.js")]
      .map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "agent-plan-first-fixture" },
    r2Buckets: ["FILES"],
    bindings: { GITHUB_APP_ID: "424242", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.origin === "https://api.github.com") {
        if (request.method === "POST" && url.pathname === "/app/installations/9101/access_tokens") {
          const body = await request.json();
          assert.deepEqual(body.repository_ids, [5101]);
          return reply(201, { token: "ghs_plan_first_fake", expires_at: "2026-11-03T13:00:00Z", repositories: [{ id: 5101, full_name: "tanyan-research-lab/pf-a" }] });
        }
        if (request.method === "GET" && url.pathname === "/repos/tanyan-research-lab/pf-a/git/ref/heads/main") {
          return reply(200, { ref: "refs/heads/main", object: { type: "commit", sha: baseSha } });
        }
      }
      unexpected.push(`${request.method} ${request.url}`);
      return new Response("No other external services in this test", { status: 502 });
    },
  });
  const origin = "http://localhost";
  const studentActors = new Set(["a", "b"]);
  const cookie = (actor) => `tanyan_session=pf-${actor}; tanyan_persona=${studentActors.has(actor) ? "student" : "management"}`;
  const userPost = (body, actor) => mf.dispatchFetch(`${origin}/api/agent-attempts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie: cookie(actor) },
    body: JSON.stringify(body),
  });
  const userGet = (query, actor) => mf.dispatchFetch(`${origin}/api/agent-attempts?${query}`, { headers: { cookie: cookie(actor) } });
  const tokens = {};
  const lab = (body, worker = "w1") => mf.dispatchFetch(`${origin}/api/lab/agent-attempts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens[worker]}` },
    body: JSON.stringify(body),
  });
  const expectJson = async (response, expected = 200) => {
    assert.equal(response.status, expected, await response.clone().text());
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
    return response.json();
  };
  const content = {
    title: "先出计划再改代码", researchQuestion: "数据增强是否提升泛化？", hypothesis: "随机裁剪更稳健",
    instructions: "只修改 src 下的数据管道", acceptanceCriteria: "单元测试通过",
    allowedPaths: ["src/**"], budget: { maxAgentMinutes: 20 },
  };
  const fileOf = (path, text, action = "modify") => ({
    path, action, contentBase64: Buffer.from(text).toString("base64"), sha256: createHash("sha256").update(text).digest("hex"),
  });
  const result = (attemptId, leaseEpoch, overrides = {}) => ({
    action: "result", attemptId, leaseEpoch, outcome: "change_ready", modelId: "gpt-5-codex", sdkVersion: "0.0.0-test",
    files: [fileOf("src/data.py", "crop = True\n")], unifiedDiff: "diff --git a/src/data.py b/src/data.py\n",
    tests: [{ command: "pytest", exitCode: 0, summary: "ok" }], usage: { inputTokens: 10 }, ...overrides,
  });
  const planText = "1. 在 src/data.py 中加入随机裁剪\n2. 补充 tests/test_data.py\n不触及受保护路径。";
  const planResult = (attemptId, leaseEpoch, overrides = {}) => result(attemptId, leaseEpoch, { outcome: "plan_ready", plan: planText, files: [], unifiedDiff: "", ...overrides });
  const event = (sequence) => ({ sequence, kind: "message", payload: { text: `step ${sequence}` } });

  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('pf-a', '计划测试甲', '博士', 2025, '实验', 1), ('pf-b', '计划测试乙', '硕士', 2025, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (801, 'pf-a-user', '计划测试甲', 'student', 'pf-a'),
      (802, 'pf-b-user', '计划测试乙', 'student', 'pf-b'),
      (803, 'pf-mentor-user', '范围导师', 'mentor', NULL),
      (804, 'pf-viewer-user', '只读导师', 'mentor', NULL),
      (805, 'pf-super-user', '超级管理员', 'superadmin', NULL),
      (806, 'pf-outsider-user', '其他导师', 'mentor', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (803, 'pf-a', 1, 1), (804, 'pf-a', 0, 1)`).run();
    for (const [id, actor] of [[801, "a"], [802, "b"], [803, "mentor"], [804, "viewer"], [805, "super"], [806, "outsider"]]) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`pf-${actor}`), id).run();
    }
    await db.prepare(`INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (9101, 'tanyan-research-lab', 'Organization')`).run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch)
      VALUES ('pf-a', 5101, 9101, 'tanyan-research-lab/pf-a', 'main')`).run();
    for (const id of ["rnr_w1", "rnr_w2"]) {
      const issued = await issueRunnerToken();
      tokens[id.replace("rnr_", "")] = issued.token;
      await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES (?, ?, 'agent', ?)").bind(id, id, issued.tokenSha256).run();
    }
    await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES
      ('cred_pf_a', 801, 'codex', 'rnr_w1'), ('cred_pf_m', 803, 'codex', 'rnr_w1')`).run();

    const postTask = (body, actor = "a") => mf.dispatchFetch(`${origin}/api/research-tasks`, {
      method: "POST", headers: { "content-type": "application/json", origin, cookie: cookie(actor) }, body: JSON.stringify(body),
    });
    const created = await expectJson(await postTask({ action: "create", studentId: "pf-a", mutationId: "pf-task-main", ...content }));
    const taskId = created.task.id;
    await expectJson(await postTask({ action: "confirm", taskId, version: 1 }));

    let keySeq = 0;
    const start = (actor, overrides = {}) => userPost({ action: "start", taskId, provider: "codex", idempotencyKey: `pf-start-${++keySeq}-key`, ...overrides }, actor);
    const claim = async (worker = "w1") => (await expectJson(await lab({ action: "claim" }, worker))).work;
    const attemptRow = (id) => db.prepare("SELECT * FROM agent_attempts WHERE id = ?").bind(id).first();
    const planRow = (id) => db.prepare("SELECT * FROM agent_attempt_plans WHERE attempt_id = ?").bind(id).first();
    const audit = async (id) => (await db.prepare("SELECT sequence, payload_json FROM agent_attempt_events WHERE attempt_id = ? AND sequence < 0 ORDER BY sequence DESC")
      .bind(id).all()).results.map((row) => ({ sequence: row.sequence, ...JSON.parse(row.payload_json) }));
    const detail = async (id, actor) => expectJson(await userGet(`attemptId=${id}`, actor));

    let mainId;
    let mainPlanVersion;

    await t.test("start with planFirst inserts the plan row and its audit entry in the same batch", async () => {
      await expectJson(await start("a", { planFirst: "yes" }), 400);
      const key = "pf-start-main-key";
      const started = await expectJson(await start("a", { planFirst: true, idempotencyKey: key }));
      assert.equal(started.planFirst, true);
      assert.equal(started.replayed, false);
      assert.equal(started.attempt.status, "queued");
      mainId = started.attempt.id;
      const plan = await planRow(mainId);
      assert.equal(plan.decision, "awaiting_plan");
      assert.equal(plan.version, 1);
      assert.equal(plan.plan_text, "");
      assert.deepEqual((await audit(mainId)).map((entry) => [entry.sequence, entry.action, entry.userId]), [[-1, "plan_requested", 801]]);
      // Idempotent replay; the same key cannot switch modes.
      const replay = await expectJson(await start("a", { planFirst: true, idempotencyKey: key }));
      assert.equal(replay.replayed, true);
      assert.equal(replay.attempt.id, mainId);
      await expectJson(await start("a", { idempotencyKey: key }), 409);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM agent_attempt_plans").first()).n, 1);
      const view = await detail(mainId, "a");
      assert.deepEqual(view.plan, { text: "", decision: "awaiting_plan", submittedAt: null, decidedBy: null, decidedAt: null, note: "", version: 1 });
      assert.deepEqual(view.permissions, { canDecidePlan: false });
    });

    await t.test("plan mode: claim hands out mode plan; change_ready and malformed plans are rejected; fencing applies", async () => {
      const work = await claim();
      assert.equal(work.attemptId, mainId);
      assert.equal(work.mode, "plan");
      assert.equal(work.approvedPlan, null);
      assert.equal(work.leaseEpoch, 1);
      const events = await expectJson(await lab({ action: "events", attemptId: mainId, leaseEpoch: 1, events: [event(1), event(2), event(3)] }));
      assert.deepEqual([events.accepted, events.lastSequence], [3, 3]);
      const changeInPlan = await expectJson(await lab(result(mainId, 1)), 400);
      assert.equal(changeInPlan.code, "INVALID_RESULT");
      await expectJson(await lab(planResult(mainId, 1, { plan: "   " })), 400);
      await expectJson(await lab(planResult(mainId, 1, { plan: undefined })), 400);
      await expectJson(await lab(planResult(mainId, 1, { plan: "x".repeat(20_001) })), 413);
      await expectJson(await lab(planResult(mainId, 1, { files: [fileOf("src/data.py", "x\n")] })), 400);
      await expectJson(await lab(planResult(mainId, 1, { unifiedDiff: "diff --git a/x b/x\n" })), 400);
      await expectJson(await lab(result(mainId, 1, { outcome: "failed", plan: "not allowed here" })), 400);
      assert.equal((await expectJson(await lab(planResult(mainId, 2)), 409)).code, "LEASE_LOST");
      assert.equal((await expectJson(await lab(planResult(mainId, 1), "w2"), 409)).code, "LEASE_LOST");
      assert.equal((await attemptRow(mainId)).status, "running", "rejected results never change state");
      assert.equal((await planRow(mainId)).decision, "awaiting_plan");
    });

    await t.test("plan_ready stores the plan, waits for approval and releases the lease", async () => {
      const response = await expectJson(await lab(planResult(mainId, 1)));
      assert.equal(response.status, "waiting_approval");
      assert.equal(response.changeRequest, null);
      assert.equal(response.replayed, false);
      const row = await attemptRow(mainId);
      assert.equal(row.status, "waiting_approval");
      assert.equal(row.lease_expires_at, null);
      assert.equal(row.ended_at, null);
      const plan = await planRow(mainId);
      assert.equal(plan.decision, "pending");
      assert.equal(plan.plan_text, planText);
      assert.equal(plan.plan_sha256, await sha256Hex(planText));
      assert.ok(plan.submitted_at);
      assert.equal(plan.version, 2);
      mainPlanVersion = plan.version;
      // Same-epoch retry answers with what was stored; the released lease is dead.
      assert.equal((await expectJson(await lab(planResult(mainId, 1)))).replayed, true);
      assert.equal((await expectJson(await lab({ action: "heartbeat", attemptId: mainId, leaseEpoch: 1 }), 409)).code, "LEASE_LOST");
      await expectJson(await lab({ action: "events", attemptId: mainId, leaseEpoch: 1, events: [event(4)] }), 409);
      // Waiting for a human never expires, and claim does not hand it out.
      assert.equal(await claim(), null);
      assert.equal((await attemptRow(mainId)).status, "waiting_approval");
    });

    await t.test("GET detail exposes the plan and canDecidePlan only to deciders other than the requester", async () => {
      const own = await detail(mainId, "a");
      assert.equal(own.attempt.status, "waiting_approval");
      assert.equal(own.plan.text, planText);
      assert.equal(own.plan.decision, "pending");
      assert.equal(own.plan.version, 2);
      assert.equal(own.permissions.canDecidePlan, false, "the requester cannot approve their own plan");
      assert.deepEqual(own.events.map((item) => item.sequence), [1, 2, 3], "platform audit entries stay out of the event stream");
      assert.equal((await detail(mainId, "mentor")).permissions.canDecidePlan, true);
      assert.equal((await detail(mainId, "super")).permissions.canDecidePlan, true);
      assert.equal((await detail(mainId, "viewer")).permissions.canDecidePlan, false, "view-only mentors cannot decide");
      for (const actor of ["b", "outsider"]) await expectJson(await userGet(`attemptId=${mainId}`, actor), 404);
    });

    await t.test("decide_plan: validation, scope, no self-approval and CAS on the plan version", async () => {
      const decide = (actor, overrides = {}) => userPost({ action: "decide_plan", attemptId: mainId, decision: "approved", note: "同意", expectedVersion: mainPlanVersion, ...overrides }, actor);
      await expectJson(await decide("mentor", { decision: "maybe" }), 400);
      await expectJson(await decide("mentor", { expectedVersion: "2" }), 400);
      await expectJson(await decide("mentor", { note: "x".repeat(2001) }), 400);
      const self = await expectJson(await decide("a"), 403);
      assert.equal(self.code, "FORBIDDEN");
      await expectJson(await decide("viewer"), 403);
      await expectJson(await decide("b"), 404);
      await expectJson(await decide("outsider"), 404);
      const stale = await expectJson(await decide("mentor", { expectedVersion: 1 }), 409);
      assert.equal(stale.code, "VERSION_CONFLICT");
      assert.equal((await planRow(mainId)).decision, "pending");

      const approved = await expectJson(await decide("mentor"));
      assert.equal(approved.attempt.status, "queued");
      assert.equal(approved.plan.decision, "approved");
      assert.equal(approved.plan.version, 3);
      assert.deepEqual(approved.plan.decidedBy, { id: 803, displayName: "范围导师" });
      assert.equal(approved.plan.note, "同意");
      assert.ok(approved.plan.decidedAt);
      assert.equal((await expectJson(await decide("mentor"), 409)).code, "VERSION_CONFLICT");
      assert.equal((await expectJson(await decide("super", { expectedVersion: 3 }), 409)).code, "PLAN_NOT_PENDING");
    });

    await t.test("edit phase: claim carries the approved plan; events continue; path policy and change request unchanged", async () => {
      const work = await claim();
      assert.equal(work.attemptId, mainId);
      assert.equal(work.mode, "edit");
      assert.equal(work.approvedPlan, planText);
      assert.equal(work.leaseEpoch, 2);
      // Old plan-phase lease is fenced off.
      assert.equal((await expectJson(await lab(result(mainId, 1)), 409)).code, "LEASE_LOST");
      assert.equal((await expectJson(await lab({ action: "heartbeat", attemptId: mainId, leaseEpoch: 1 }), 409)).code, "LEASE_LOST");
      // A restarted worker numbers events from 1 again; they are kept after the plan phase.
      const events = await expectJson(await lab({ action: "events", attemptId: mainId, leaseEpoch: 2, events: [event(1), event(2)] }));
      assert.deepEqual([events.accepted, events.duplicates, events.lastSequence], [2, 0, 2]);
      const retry = await expectJson(await lab({ action: "events", attemptId: mainId, leaseEpoch: 2, events: [event(2), event(3)] }));
      assert.deepEqual([retry.accepted, retry.duplicates, retry.lastSequence], [1, 1, 3]);
      assert.deepEqual((await detail(mainId, "a")).events.map((item) => item.sequence), [1, 2, 3, 4, 5, 6]);
      await expectJson(await lab(planResult(mainId, 2)), 400);
      const outside = await expectJson(await lab(result(mainId, 2, { files: [fileOf("docs/x.md", "x\n", "add")] })));
      assert.equal(outside.status, "failed");
      assert.equal(outside.errorCode, "POLICY_VIOLATION");
      assert.equal(outside.changeRequest, null);
    });

    await t.test("full flow ends in a change request; every step is audited", async () => {
      const started = await expectJson(await start("a", { planFirst: true }));
      const id = started.attempt.id;
      assert.equal((await claim()).mode, "plan");
      await expectJson(await lab(planResult(id, 1)));
      await expectJson(await userPost({ action: "decide_plan", attemptId: id, decision: "approved", note: "", expectedVersion: 2 }, "super"));
      const work = await claim();
      assert.deepEqual([work.attemptId, work.mode, work.approvedPlan, work.leaseEpoch], [id, "edit", planText, 2]);
      const done = await expectJson(await lab(result(id, 2)));
      assert.equal(done.status, "change_ready");
      assert.equal(done.changeRequest.status, "pending_review");
      assert.equal(done.changeRequest.requiresExtraReview, false);
      const view = await detail(id, "a");
      assert.equal(view.changeRequest.id, done.changeRequest.id);
      assert.equal(view.plan.decision, "approved");
      assert.equal(view.permissions.canDecidePlan, false);
      const trail = await audit(id);
      assert.deepEqual(trail.map((entry) => entry.action), ["plan_requested", "plan_phase_claimed", "plan_submitted", "plan_approved", "edit_phase_claimed"]);
      assert.deepEqual(trail.map((entry) => entry.sequence), [-1, -2, -3, -4, -5]);
      assert.equal(trail[2].planSha256, await sha256Hex(planText));
      assert.equal(trail[2].lastWorkerSequence, 0);
      assert.equal(trail[3].userId, 805);
      assert.deepEqual([trail[1].leaseEpoch, trail[4].leaseEpoch], [1, 2]);
    });

    await t.test("reject flow: the owning student rejects a mentor's plan; the attempt is canceled with PLAN_REJECTED", async () => {
      const started = await expectJson(await start("mentor", { planFirst: true }));
      const id = started.attempt.id;
      assert.equal((await claim()).attemptId, id);
      await expectJson(await lab(planResult(id, 1)));
      assert.equal((await detail(id, "mentor")).permissions.canDecidePlan, false);
      assert.equal((await detail(id, "a")).permissions.canDecidePlan, true);
      const self = await expectJson(await userPost({ action: "decide_plan", attemptId: id, decision: "approved", note: "", expectedVersion: 2 }, "mentor"), 403);
      assert.equal(self.code, "FORBIDDEN");
      const rejected = await expectJson(await userPost({ action: "decide_plan", attemptId: id, decision: "rejected", note: "范围太大", expectedVersion: 2 }, "a"));
      assert.equal(rejected.attempt.status, "canceled");
      assert.equal(rejected.attempt.errorCode, "PLAN_REJECTED");
      assert.match(rejected.attempt.errorMessage, /范围太大/);
      assert.equal(rejected.plan.decision, "rejected");
      assert.equal(rejected.plan.version, 3);
      assert.equal(await claim(), null, "a rejected plan is never dispatched");
      assert.equal((await db.prepare("SELECT count(*) AS n FROM change_requests WHERE attempt_id = ?").bind(id).first()).n, 0);
      assert.deepEqual((await audit(id)).map((entry) => entry.action), ["plan_requested", "plan_phase_claimed", "plan_submitted", "plan_rejected"]);
    });

    await t.test("concurrent decisions on the same version: exactly one wins", async () => {
      const id = (await expectJson(await start("a", { planFirst: true }))).attempt.id;
      await claim();
      await expectJson(await lab(planResult(id, 1)));
      const body = (decision) => ({ action: "decide_plan", attemptId: id, decision, note: "", expectedVersion: 2 });
      const responses = await Promise.all([userPost(body("approved"), "mentor"), userPost(body("rejected"), "super")]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
      const plan = await planRow(id);
      assert.equal(plan.version, 3);
      const row = await attemptRow(id);
      assert.equal(row.status, plan.decision === "approved" ? "queued" : "canceled");
      assert.equal((await audit(id)).filter((entry) => entry.action === "plan_approved" || entry.action === "plan_rejected").length, 1);
      if (row.status === "queued") await expectJson(await userPost({ action: "cancel", attemptId: id }, "a"));
    });

    await t.test("cancel while the plan awaits approval ends the attempt immediately", async () => {
      const id = (await expectJson(await start("a", { planFirst: true }))).attempt.id;
      await claim();
      await expectJson(await lab(planResult(id, 1)));
      const canceled = await expectJson(await userPost({ action: "cancel", attemptId: id }, "a"));
      assert.equal(canceled.attempt.status, "canceled");
      assert.equal((await detail(id, "mentor")).permissions.canDecidePlan, false);
      assert.equal((await expectJson(await userPost({ action: "decide_plan", attemptId: id, decision: "approved", note: "", expectedVersion: 2 }, "mentor"), 409)).code, "PLAN_NOT_PENDING");
    });

    await t.test("ordinary attempts: mode edit, no approvedPlan, plan_ready rejected, decide_plan refused", async () => {
      const started = await expectJson(await start("a"));
      assert.equal(started.planFirst, false);
      const id = started.attempt.id;
      assert.equal(await planRow(id), null);
      const work = await claim();
      assert.deepEqual([work.attemptId, work.mode, work.approvedPlan], [id, "edit", null]);
      const view = await detail(id, "mentor");
      assert.equal(view.plan, null);
      assert.equal(view.permissions.canDecidePlan, false);
      assert.equal((await expectJson(await userPost({ action: "decide_plan", attemptId: id, decision: "approved", note: "", expectedVersion: 1 }, "mentor"), 409)).code, "NOT_PLAN_FIRST");
      const misplaced = await expectJson(await lab(planResult(id, work.leaseEpoch)), 400);
      assert.equal(misplaced.code, "INVALID_RESULT");
      assert.equal((await attemptRow(id)).status, "running");
      const done = await expectJson(await lab(result(id, work.leaseEpoch)));
      assert.equal(done.status, "change_ready");
      assert.deepEqual(await audit(id), []);
    });

    await t.test("a plan-phase lease still expires like any running attempt", async () => {
      const id = (await expectJson(await start("a", { planFirst: true }))).attempt.id;
      const work = await claim();
      assert.equal(work.mode, "plan");
      await db.prepare("UPDATE agent_attempts SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(id).run();
      assert.equal((await expectJson(await lab(planResult(id, work.leaseEpoch)), 409)).code, "LEASE_LOST");
      const row = await attemptRow(id);
      assert.deepEqual([row.status, row.error_code], ["failed", "LEASE_EXPIRED"]);
      assert.equal((await planRow(id)).decision, "awaiting_plan");
    });

    await t.test("canceling the task resolves a plan awaiting approval (no lease left to report back)", async () => {
      const id = (await expectJson(await start("a", { planFirst: true }))).attempt.id;
      await claim();
      await expectJson(await lab(planResult(id, 1)));
      await expectJson(await postTask({ action: "cancel", taskId }));
      const view = await detail(id, "a");
      assert.equal(view.attempt.status, "canceled");
      assert.equal(view.attempt.errorCode, "TASK_CANCELED");
    });

    assert.deepEqual(unexpected, [], "no other request left the Worker");
  } finally {
    await mf.dispose();
  }
});
