import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// FB1 peer code review (review_delegations). Every outbound request is answered
// by a minimal SIMULATED GitHub below; nothing talks to the real GitHub API.

const ORG = "tanyan-research-lab";
const BASE = "a1".repeat(20);
const TREE = "b1".repeat(20);
const sha1 = (value) => createHash("sha1").update(value).digest("hex");
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");

function fakeGithub() {
  const repository = { id: 9001, full_name: `${ORG}/study-a`, default_branch: "main" };
  const refs = new Map([["main", BASE]]);
  const pulls = [];
  const calls = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  async function handle(request) {
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com") return reply(599, { message: `unexpected host ${url.origin}` });
    const body = request.method === "GET" ? undefined : JSON.parse((await request.text()) || "null");
    const path = url.pathname;
    calls.push(`${request.method} ${path}`);
    if (request.method === "POST" && path === "/app/installations/77/access_tokens") {
      if (JSON.stringify(body.repository_ids) !== "[9001]") return reply(422, { message: "repository not accessible" });
      return reply(201, { token: "ghs_fake1", expires_at: "2026-11-03T13:00:00Z", permissions: body.permissions, repositories: [repository] });
    }
    const repo = `/repos/${ORG}/study-a`;
    if (!path.startsWith(repo)) return reply(404, { message: "Not Found" });
    if (request.headers.get("authorization") !== "Bearer ghs_fake1") return reply(401, { message: "Bad credentials" });
    const rest = path.slice(repo.length);
    if (request.method === "GET" && rest === `/git/commits/${BASE}`) return reply(200, { sha: BASE, tree: { sha: TREE } });
    if (request.method === "POST" && rest === "/git/blobs") return reply(201, { sha: sha1(`blob:${body.content}`) });
    if (request.method === "POST" && rest === "/git/trees") return reply(201, { sha: sha1(`tree:${JSON.stringify(body)}`) });
    if (request.method === "POST" && rest === "/git/commits") return reply(201, { sha: sha1(`commit:${JSON.stringify(body)}`) });
    let match = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
    if (request.method === "GET" && match) {
      const branch = match[1].split("/").map(decodeURIComponent).join("/");
      return refs.has(branch) ? reply(200, { object: { type: "commit", sha: refs.get(branch) } }) : reply(404, { message: "Not Found" });
    }
    if (request.method === "POST" && rest === "/git/refs") {
      const branch = body.ref.replace(/^refs\/heads\//, "");
      if (refs.has(branch)) return reply(422, { message: "Reference already exists" });
      refs.set(branch, body.sha);
      return reply(201, { ref: body.ref, object: { type: "commit", sha: body.sha } });
    }
    if (request.method === "GET" && rest === "/pulls") {
      return reply(200, pulls.filter((pull) => `${ORG}:${pull.head.ref}` === url.searchParams.get("head")));
    }
    if (request.method === "POST" && rest === "/pulls") {
      const number = pulls.length + 1;
      const pull = { number, html_url: `https://github.com/${ORG}/study-a/pull/${number}`, state: "open", merged_at: null, head: { ref: body.head, sha: refs.get(body.head) } };
      pulls.push(pull);
      return reply(201, pull);
    }
    return reply(404, { message: "Not Found" });
  }
  return { calls, pulls, outbound: (request) => handle(request).catch((error) => reply(599, { message: error.message })) };
}

async function workerModules() {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  return {
    modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
    modulesRoot: root,
  };
}

test("FB1 peer code review delegations (simulated GitHub)", { timeout: 180_000 }, async (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gh = fakeGithub();
  const mf = new Miniflare({
    ...await workerModules(),
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "review-delegation-fixture" },
    r2Buckets: ["FILES"],
    bindings: {
      GITHUB_APP_ID: "424242",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
      GITHUB_WEBHOOK_SECRET: "fixture-secret",
      GITHUB_APP_SLUG: "tanyan-lab",
    },
    outboundService: (request) => gh.outbound(request),
  });
  const origin = "http://localhost";
  const actors = {
    a: [1101, "student"], b: [1102, "student"], mentor: [1103, "management"], viewer: [1104, "management"],
    peer: [1105, "student"], eng: [1106, "management"], owner: [1108, "management"],
  };
  const cookie = (actor) => `tanyan_session=rd-${actor}; tanyan_persona=${actors[actor][1]}`;
  const expectJson = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return text ? JSON.parse(text) : null;
  };
  const get = (path, actor) => mf.dispatchFetch(`${origin}${path}`, { headers: { cookie: cookie(actor) } });
  const post = (path, body, actor, extra = {}) => mf.dispatchFetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin, cookie: cookie(actor), ...extra }, body: JSON.stringify(body),
  });
  const delegations = (body, actor, extra) => post("/api/review-delegations", body, actor, extra);
  const crPost = (body, actor) => post("/api/change-requests", body, actor);

  try {
    const db = await applyD1Migrations(mf);
    const bucket = await mf.getR2Bucket("FILES");
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('rd-a', '甲同学', '博士', 2025, '实验', 1), ('rd-b', '乙同学', '硕士', 2025, '实验', 1),
      ('rd-p', '同伴学生', '博士', 2022, '论文', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, email, role, student_id, active) VALUES
      (1101, 'ou-rd-a', '甲同学', 'a@example.com', 'student', 'rd-a', 1), (1102, 'ou-rd-b', '乙同学', '', 'student', 'rd-b', 1),
      (1103, 'ou-rd-mentor', '审核导师', '', 'mentor', NULL, 1), (1104, 'ou-rd-viewer', '只读导师', '', 'mentor', NULL, 1),
      (1105, 'ou-rd-peer', '同伴学生', 'peer@example.com', 'student', 'rd-p', 1), (1106, 'ou-rd-eng', '研发工程师', '', 'mentor', NULL, 1),
      (1107, 'ou-rd-pending', '待审核', '', 'pending', NULL, 1), (1108, 'ou-rd-owner', '超级管理员', '', 'superadmin', NULL, 1),
      (1109, 'ou-rd-inactive', '已停用', '', 'mentor', NULL, 0)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (1103, 'rd-a', 1, 1), (1104, 'rd-a', 0, 1)`).run();
    for (const [actor, [id]] of Object.entries(actors)) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").bind(digest(`rd-${actor}`), id).run();
    }
    await db.prepare(`INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (77, ?, 'Organization')`).bind(ORG).run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch, verified_by_user_id)
      VALUES ('rd-a', 9001, 77, ?, 'main', 1108)`).bind(`${ORG}/study-a`).run();
    await db.prepare(`INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_agent', 'agent', 'agent', ?), ('rnr_compute', 'gpu', 'compute', ?)`)
      .bind("f".repeat(64), "e".repeat(64)).run();
    await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES
      ('cred_a', 1101, 'codex', 'rnr_agent'), ('cred_b', 1102, 'codex', 'rnr_agent'), ('cred_e', 1106, 'codex', 'rnr_agent')`).run();

    let seeded = 0;
    async function seed({ suffix, studentId = "rd-a", requiresExtraReview = 0, requester = 1101, credential = "cred_a", path = "src/model.py" }) {
      seeded += 1;
      const taskId = `task_${suffix}`;
      const attemptId = `att_${suffix}`;
      const id = `cr_${suffix}`;
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
        VALUES (?, ?, ?, 'confirmed', 1, 1, ?, ?, ?)`).bind(taskId, studentId, `改进训练脚本 ${suffix}`, requester, `mut_${suffix}`, `mut_${suffix}`).run();
      await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
        allowed_paths_json, protected_paths_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
        VALUES (?, 1, ?, '问题', '说明', '验收', '[]', ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .bind(taskId, `改进训练脚本 ${suffix}`, JSON.stringify(["evaluation/**"]), "e".repeat(64), requester, requester).run();
      await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, model_id, credential_profile_id,
        github_repository_id, base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
        VALUES (?, ?, 1, ?, 'codex', 'gpt-5-codex', ?, 9001, ?, ?, 'change_ready', ?, ?)`)
        .bind(attemptId, taskId, studentId, credential, BASE, "c".repeat(64), `idem_${suffix}`, requester).run();
      await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name,
        status, requires_extra_review, created_at) VALUES (?, ?, ?, ?, 9001, ?, ?, 'pending_review', ?, '2026-11-03 08:00:0${seeded % 10}')`)
        .bind(id, taskId, attemptId, studentId, BASE, `tanyan/t${suffix}/a${suffix}`, requiresExtraReview).run();
      const content = "print('trained')\n";
      await bucket.put(`agent-attempts/${attemptId}/change.json`, JSON.stringify({
        files: [{ path, action: "modify", contentBase64: b64(content), sha256: createHash("sha256").update(content).digest("hex") }],
        unifiedDiff: `diff --git a/${path} b/${path}\n`,
      }));
      return { id, taskId };
    }
    const plain = await seed({ suffix: "plain0001" });
    const guarded = await seed({ suffix: "guard0001", requiresExtraReview: 1, path: "evaluation/score.py" });
    const ownAttempt = await seed({ suffix: "owned0001", requester: 1106, credential: "cred_e" });
    const toReject = await seed({ suffix: "rejct0001" });
    const later = await seed({ suffix: "later0001" });
    const other = await seed({ suffix: "other0001", studentId: "rd-b", requester: 1102, credential: "cred_b" });

    // One run of the delegated student (awaiting approval) to prove runs stay out of reach.
    await db.prepare(`INSERT INTO dataset_versions(id, label, runner_id, manifest_sha256, egress_policy_json, created_by_user_id)
      VALUES ('ds_rd1', '数据集', 'rnr_compute', ?, '{}', 1108)`).bind("d".repeat(64)).run();
    await db.prepare(`INSERT INTO registered_entrypoints(id, github_repository_id, name, argv_json, image_ref, created_by_user_id)
      VALUES ('ep_rd1', 9001, 'train', '["python","train.py"]', 'lab/train:1', 1108)`).run();
    await db.prepare(`INSERT INTO run_specs(sha256, canonical_json, task_id, task_version, student_id, github_repository_id, executed_commit_sha,
      entrypoint_id, dataset_version_id, created_by_user_id) VALUES (?, '{}', ?, 1, 'rd-a', 9001, ?, 'ep_rd1', 'ds_rd1', 1101)`)
      .bind("9".repeat(64), plain.taskId, BASE).run();
    await db.prepare(`INSERT INTO runs(id, run_spec_sha256, task_id, student_id, idempotency_key, submit_tag, created_by_user_id)
      VALUES ('run_rd1', ?, ?, 'rd-a', 'idem_run_rd1', 'tag_run_rd1', 1101)`).bind("9".repeat(64), plain.taskId).run();

    let peerDelegationId = "";

    await t.test("only reviewers in scope or a superadmin can grant; reviewer must be another active user", async () => {
      const grant = (reviewerUserId, actor = "mentor", studentId = "rd-a") => delegations({ action: "grant", studentId, reviewerUserId }, actor);
      for (const actor of ["a", "viewer", "eng", "b", "peer"]) await expectJson(await grant(1105, actor), 403);
      await expectJson(await grant(1105, "mentor", "rd-b"), 403);
      await expectJson(await delegations({ action: "grant", studentId: "rd-a", reviewerUserId: 1105 }, "mentor", { origin: "https://evil.example" }), 403);
      assert.equal((await expectJson(await grant(1101), 400)).code, "SELF_DELEGATION", "never to the student themself");
      assert.equal((await expectJson(await grant(1103), 400)).code, "SELF_DELEGATION");
      assert.equal((await expectJson(await grant(1107), 400)).code, "REVIEWER_PENDING");
      await expectJson(await grant(1109), 404);
      await expectJson(await grant(99999), 404);
      await expectJson(await grant("abc"), 400);
      await expectJson(await delegations({ action: "grant", studentId: "rd-missing", reviewerUserId: 1105 }, "owner"), 404);
      assert.equal((await db.prepare("SELECT count(*) AS n FROM review_delegations").first()).n, 0);

      const first = await expectJson(await grant(1105));
      assert.equal(first.created, true);
      assert.match(first.delegation.id, /^rdg_[0-9a-f]{32}$/);
      const again = await expectJson(await grant(1105));
      assert.equal(again.created, false, "grant is idempotent");
      assert.equal(again.delegation.id, first.delegation.id);
      peerDelegationId = first.delegation.id;
      assert.equal((await expectJson(await grant(1106, "owner"))).created, true, "a superadmin may delegate");
      assert.equal((await db.prepare("SELECT count(*) AS n FROM review_delegations WHERE active = 1").first()).n, 2);
      const row = await db.prepare("SELECT delegated_by_user_id FROM review_delegations WHERE id = ?").bind(peerDelegationId).first();
      assert.equal(row.delegated_by_user_id, 1103);
    });

    await t.test("listing shows names and dates only; mine=1 lists minimal fields", async () => {
      const list = await expectJson(await get("/api/review-delegations?studentId=rd-a", "mentor"));
      assert.equal(list.delegations.length, 2);
      const peer = list.delegations.find((item) => item.reviewerUserId === 1105);
      assert.deepEqual(Object.keys(peer).sort(), ["active", "createdAt", "delegatedByName", "id", "reviewerName", "reviewerUserId", "revokedAt", "revokedByName", "studentId"]);
      assert.equal(peer.reviewerName, "同伴学生");
      assert.equal(peer.delegatedByName, "审核导师");
      const text = JSON.stringify(list);
      assert.ok(!text.includes("@example.com") && !text.includes("ou-rd-"), "no emails or open IDs");
      for (const actor of ["viewer", "peer", "a", "eng"]) await expectJson(await get("/api/review-delegations?studentId=rd-a", actor), 403);
      await expectJson(await get("/api/review-delegations", "mentor"), 400);
      const mine = await expectJson(await get("/api/review-delegations?mine=1", "peer"));
      assert.equal(mine.students.length, 1);
      assert.deepEqual(Object.keys(mine.students[0]).sort(), ["displayName", "since", "studentId"]);
      assert.equal(mine.students[0].studentId, "rd-a");
      assert.deepEqual((await expectJson(await get("/api/review-delegations?mine=1", "b"))).students, []);
    });

    await t.test("a delegate reads the student's tasks and change requests, but cannot edit tasks", async () => {
      const tasks = await expectJson(await get("/api/research-tasks?studentId=rd-a", "peer"));
      assert.ok(tasks.tasks.some((task) => task.id === plain.taskId));
      const detail = await expectJson(await get(`/api/research-tasks?taskId=${plain.taskId}`, "peer"));
      assert.equal(detail.task.studentId, "rd-a");
      const { providers, ...flags } = detail.permissions;
      assert.deepEqual(flags, { canRevise: false, canConfirm: false, canClose: false, canCancel: false, canStartAttempt: false });
      assert.deepEqual(providers, []);
      await expectJson(await post("/api/research-tasks", { action: "cancel", taskId: plain.taskId, mutationId: "mut_peer_cancel_1" }, "peer"), 404);
      await expectJson(await post("/api/research-tasks", { action: "confirm", taskId: plain.taskId, version: 1 }, "peer"), 404);

      const list = await expectJson(await get(`/api/change-requests?taskId=${plain.taskId}`, "peer"));
      assert.deepEqual(list.changeRequests[0].permissions, { canPublish: true, canApproveExtraReview: false, canReject: true });
      const guardedView = await expectJson(await get(`/api/change-requests?changeRequestId=${guarded.id}`, "peer"));
      assert.deepEqual(guardedView.permissions, { canPublish: false, canApproveExtraReview: false, canReject: false });
      const ownView = await expectJson(await get(`/api/change-requests?changeRequestId=${ownAttempt.id}`, "eng"));
      assert.deepEqual(ownView.permissions, { canPublish: false, canApproveExtraReview: false, canReject: false });
    });

    await t.test("no access to runs, results, progress or other students", async () => {
      for (const actor of ["peer", "eng"]) {
        await expectJson(await get("/api/runs?studentId=rd-a", actor), 403);
        await expectJson(await get(`/api/runs?taskId=${plain.taskId}`, actor), 403);
        await expectJson(await post("/api/runs", { action: "approve", runId: "run_rd1", runSpecSha256: "9".repeat(64) }, actor), 403);
        await expectJson(await post("/api/run-results", { action: "review", runId: "run_rd1", expectedVersion: 1, state: "accepted" }, actor), 403);
        // Existing progress endpoint keeps using canViewStudent.
        const progress = await get("/api/progress-resolutions?view=completed&studentId=rd-a", actor);
        assert.equal(progress.status, 403, await progress.text());
        await expectJson(await get("/api/research-tasks?studentId=rd-b", actor), 403);
        await expectJson(await get(`/api/research-tasks?taskId=${other.taskId}`, actor), 404);
        await expectJson(await get(`/api/change-requests?changeRequestId=${other.id}`, actor), 404);
        await expectJson(await crPost({ action: "publish", changeRequestId: other.id, expectedVersion: 1 }, actor), 404);
      }
      const guidance = await get("/api/student-guidance?studentId=rd-a", "eng");
      assert.equal(guidance.status, 403, await guidance.text());
      assert.equal((await db.prepare("SELECT count(*) AS n FROM run_approvals").first()).n, 0);
    });

    await t.test("protected changes and extra review stay with the mentor; own attempts are not peer-reviewable", async () => {
      const before = JSON.stringify(await db.prepare("SELECT * FROM change_requests WHERE id = ?").bind(guarded.id).first());
      for (const action of ["publish", "reject", "approve_extra_review"]) {
        await expectJson(await crPost({ action, changeRequestId: guarded.id, expectedVersion: 1 }, "peer"), 403);
      }
      assert.equal(JSON.stringify(await db.prepare("SELECT * FROM change_requests WHERE id = ?").bind(guarded.id).first()), before);
      const approved = await expectJson(await crPost({ action: "approve_extra_review", changeRequestId: guarded.id, expectedVersion: 1 }, "mentor"));
      assert.ok(approved.changeRequest.extraReviewApprovedAt);
      // Even after the mentor's extra review, a protected change is never peer-published.
      await expectJson(await crPost({ action: "publish", changeRequestId: guarded.id, expectedVersion: approved.changeRequest.version }, "peer"), 403);
      for (const action of ["publish", "reject"]) {
        const denied = await expectJson(await crPost({ action, changeRequestId: ownAttempt.id, expectedVersion: 1 }, "eng"), 403);
        assert.match(denied.error, /自己发起/);
      }
    });

    await t.test("a delegate publishes a non-protected change through the simulated GitHub and rejects another", async () => {
      gh.calls.length = 0;
      const data = await expectJson(await crPost({ action: "publish", changeRequestId: plain.id, expectedVersion: 1 }, "peer"));
      assert.equal(data.changeRequest.status, "open");
      assert.equal(data.changeRequest.publishedByUserId, 1105);
      assert.equal(data.changeRequest.prNumber, 1);
      assert.equal(gh.calls[0], "POST /app/installations/77/access_tokens");
      assert.ok(gh.calls.includes(`POST /repos/${ORG}/study-a/pulls`));
      assert.equal(gh.pulls.length, 1);
      const rejected = await expectJson(await crPost({ action: "reject", changeRequestId: toReject.id, expectedVersion: 1 }, "eng"));
      assert.equal(rejected.changeRequest.status, "rejected");
    });

    await t.test("revocation takes effect on the next request and keeps the audit row", async () => {
      await expectJson(await get(`/api/change-requests?changeRequestId=${later.id}`, "peer"));
      await expectJson(await delegations({ action: "revoke", delegationId: peerDelegationId }, "viewer"), 404);
      await expectJson(await delegations({ action: "revoke", delegationId: peerDelegationId }, "peer"), 404);
      await expectJson(await delegations({ action: "revoke", delegationId: "bad id" }, "mentor"), 400);
      const revoked = await expectJson(await delegations({ action: "revoke", delegationId: peerDelegationId }, "mentor"));
      assert.equal(revoked.revoked, true);
      assert.equal(revoked.delegation.active, false);
      assert.equal(revoked.delegation.revokedByName, "审核导师");
      assert.equal((await expectJson(await delegations({ action: "revoke", delegationId: peerDelegationId }, "mentor"))).revoked, false);
      const row = await db.prepare("SELECT active, revoked_at, revoked_by_user_id FROM review_delegations WHERE id = ?").bind(peerDelegationId).first();
      assert.equal(row.active, 0);
      assert.ok(row.revoked_at);
      assert.equal(row.revoked_by_user_id, 1103);

      await expectJson(await get(`/api/change-requests?changeRequestId=${later.id}`, "peer"), 404);
      await expectJson(await crPost({ action: "publish", changeRequestId: later.id, expectedVersion: 1 }, "peer"), 404);
      await expectJson(await get("/api/research-tasks?studentId=rd-a", "peer"), 403);
      await expectJson(await get(`/api/research-tasks?taskId=${later.taskId}`, "peer"), 404);
      assert.deepEqual((await expectJson(await get("/api/review-delegations?mine=1", "peer"))).students, []);
      const list = await expectJson(await get("/api/review-delegations?studentId=rd-a", "mentor"));
      assert.equal(list.delegations.find((item) => item.id === peerDelegationId).active, false, "revoked rows stay listed for audit");

      // Re-granting creates a fresh row; losing the delegator's own review scope voids it too.
      const regrant = await expectJson(await delegations({ action: "grant", studentId: "rd-a", reviewerUserId: 1105 }, "mentor"));
      assert.equal(regrant.created, true);
      assert.notEqual(regrant.delegation.id, peerDelegationId);
      await expectJson(await get(`/api/change-requests?changeRequestId=${later.id}`, "peer"));
      await db.prepare("UPDATE mentor_student_assignments SET can_review = 0 WHERE mentor_user_id = 1103 AND student_id = 'rd-a'").run();
      await expectJson(await get(`/api/change-requests?changeRequestId=${later.id}`, "peer"), 404);
      await db.prepare("UPDATE mentor_student_assignments SET can_review = 1 WHERE mentor_user_id = 1103 AND student_id = 'rd-a'").run();
      await expectJson(await get(`/api/change-requests?changeRequestId=${later.id}`, "peer"));
      assert.equal((await db.prepare("SELECT count(*) AS n FROM review_delegations WHERE reviewer_user_id = 1105").first()).n, 2);
    });
  } finally {
    await mf.dispose();
  }
});
