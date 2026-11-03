import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, verify } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// SIMULATED GitHub. Every outbound request from the Worker is answered by the
// in-memory GitHub double below (Miniflare outboundService). Nothing here talks
// to the real GitHub API, and the App key is generated per run. These tests
// prove the platform's request sequence, payloads, idempotency and isolation
// rules; they are not evidence of a real GitHub integration (T02/T03 real
// acceptance remains pending a configured App).

const APP_ID = "424242";
const APP_SLUG = "tanyan-lab";
// Official test vector secret from GitHub's "Validating webhook deliveries".
const WEBHOOK_SECRET = "It's a Secret to Everybody";
const BASE_A = "a1".repeat(20);
const TREE_A = "b1".repeat(20);
const BASE_B = "a2".repeat(20);
const ORG = "tanyan-research-lab";

const sha1 = (value) => createHash("sha1").update(value).digest("hex");
const b64 = (value) => Buffer.from(value, "utf8").toString("base64");

function fakeGithub(publicKey) {
  const installations = new Map([
    [77, { id: 77, account: { login: ORG, type: "Organization" }, repositories: [9001, 9002, 9003] }],
    [88, { id: 88, account: { login: "other-org", type: "Organization" }, repositories: [9100] }],
  ]);
  const repositories = new Map([
    [9001, { id: 9001, full_name: `${ORG}/study-a`, default_branch: "main" }],
    [9002, { id: 9002, full_name: `${ORG}/study-b`, default_branch: "trunk" }],
    [9003, { id: 9003, full_name: `${ORG}/shared-study`, default_branch: "main" }],
    [9100, { id: 9100, full_name: "other-org/foreign", default_branch: "main" }],
  ]);
  const commits = new Map([[`9001:${BASE_A}`, { sha: BASE_A, tree: { sha: TREE_A } }], [`9002:${BASE_B}`, { sha: BASE_B, tree: { sha: "b2".repeat(20) } }]]);
  const refs = new Map([["9001:main", BASE_A], ["9002:trunk", BASE_B]]);
  const pulls = [];
  const tokens = new Map();
  const calls = [];
  const failures = [];
  let tokenCounter = 0;
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  function checkJwt(auth) {
    const jwt = auth?.replace(/^Bearer /, "") ?? "";
    const [h, p, s] = jwt.split(".");
    assert.ok(h && p && s, "App endpoints require a JWT");
    assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")), "JWT signature");
    const header = JSON.parse(Buffer.from(h, "base64url"));
    const payload = JSON.parse(Buffer.from(p, "base64url"));
    assert.equal(header.alg, "RS256");
    assert.equal(payload.iss, Number(APP_ID));
    const now = Math.floor(Date.now() / 1000);
    assert.ok(payload.iat <= now - 30 && payload.exp > now && payload.exp - now <= 600, "JWT time window");
  }

  function repoFor(fullName, auth, needs) {
    const repository = [...repositories.values()].find((repo) => repo.full_name === fullName);
    const grant = tokens.get(auth?.replace(/^Bearer /, ""));
    if (!repository || !grant || !grant.repoIds.includes(repository.id)) return null;
    for (const [permission, level] of Object.entries(needs)) {
      if (level === "write" && grant.permissions[permission] !== "write") return "forbidden";
      if (level === "read" && !grant.permissions[permission] && permission !== "metadata") return "forbidden";
    }
    return repository;
  }

  async function handle(request) {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.github.com", `unexpected outbound host ${url.origin}`);
    assert.equal(request.headers.get("x-github-api-version"), "2022-11-28");
    const method = request.method;
    const path = url.pathname;
    const text = method === "GET" ? "" : await request.text();
    const body = text ? JSON.parse(text) : undefined;
    const auth = request.headers.get("authorization");
    calls.push({ method, path: path + url.search, body, auth: auth?.startsWith("Bearer ghs_") ? "token" : "jwt" });
    const failure = failures.findIndex((item) => item.method === method && item.pattern.test(path));
    if (failure >= 0) return reply(failures.splice(failure, 1)[0].status, { message: "simulated outage" });

    if (method === "GET" && path === "/app/installations") {
      checkJwt(auth);
      return reply(200, [...installations.values()].map((item) => ({ id: item.id, app_id: Number(APP_ID), account: item.account, repository_selection: "selected", suspended_at: null })));
    }
    let match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (method === "POST" && match) {
      checkJwt(auth);
      const installation = installations.get(Number(match[1]));
      if (!installation) return reply(404, { message: "Not Found" });
      const ids = body.repository_ids ?? (body.repositories ?? []).map((name) => [...repositories.values()].find((repo) => repo.full_name === `${installation.account.login}/${name}`)?.id);
      if (!ids.length || ids.some((id) => !installation.repositories.includes(id))) return reply(422, { message: "repository not accessible" });
      const token = `ghs_fake${++tokenCounter}`;
      tokens.set(token, { installationId: installation.id, repoIds: ids, permissions: body.permissions ?? {} });
      return reply(201, { token, expires_at: "2026-11-03T13:00:00Z", permissions: body.permissions, repositories: ids.map((id) => repositories.get(id)) });
    }
    match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return reply(404, { message: "Not Found" });
    const fullName = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
    const rest = match[3] ?? "";
    if (method === "GET" && rest === "/installation") {
      checkJwt(auth);
      const repository = [...repositories.values()].find((repo) => repo.full_name === fullName);
      const installation = repository && [...installations.values()].find((item) => item.repositories.includes(repository.id));
      return installation ? reply(200, { id: installation.id, app_id: Number(APP_ID), account: installation.account, repository_selection: "selected", suspended_at: null }) : reply(404, { message: "Not Found" });
    }
    const write = method === "POST";
    const needs = rest.startsWith("/pulls") ? { pull_requests: write ? "write" : "read" } : rest ? { contents: write ? "write" : "read" } : { metadata: "read" };
    const repository = repoFor(fullName, auth, needs);
    if (repository === "forbidden") return reply(403, { message: "Resource not accessible by integration" });
    if (!repository) return reply(404, { message: "Not Found" });
    const id = repository.id;
    if (method === "GET" && rest === "") return reply(200, repository);
    if ((match = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)) && method === "GET") {
      const commit = commits.get(`${id}:${match[1]}`);
      return commit ? reply(200, commit) : reply(404, { message: "Not Found" });
    }
    if ((match = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === "GET") {
      const branch = match[1].split("/").map(decodeURIComponent).join("/");
      const sha = refs.get(`${id}:${branch}`);
      return sha ? reply(200, { ref: `refs/heads/${branch}`, object: { type: "commit", sha } }) : reply(404, { message: "Not Found" });
    }
    if (method === "POST" && rest === "/git/blobs") {
      assert.equal(body.encoding, "base64");
      return reply(201, { sha: sha1(`blob:${body.content}`) });
    }
    if (method === "POST" && rest === "/git/trees") return reply(201, { sha: sha1(`tree:${JSON.stringify(body)}`) });
    if (method === "POST" && rest === "/git/commits") {
      const sha = sha1(`commit:${JSON.stringify(body)}`);
      commits.set(`${id}:${sha}`, { sha, tree: { sha: body.tree } });
      return reply(201, { sha });
    }
    if (method === "POST" && rest === "/git/refs") {
      const branch = body.ref.replace(/^refs\/heads\//, "");
      if (refs.has(`${id}:${branch}`)) return reply(422, { message: "Reference already exists" });
      refs.set(`${id}:${branch}`, body.sha);
      return reply(201, { ref: body.ref, object: { type: "commit", sha: body.sha } });
    }
    if (method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      assert.equal(url.searchParams.get("state"), "all");
      return reply(200, pulls.filter((pull) => pull.repoId === id && `${ORG}:${pull.head.ref}` === head));
    }
    if (method === "POST" && rest === "/pulls") {
      if (pulls.some((pull) => pull.repoId === id && pull.head.ref === body.head)) return reply(422, { message: "A pull request already exists" });
      const number = pulls.filter((pull) => pull.repoId === id).length + 1;
      const pull = { repoId: id, number, html_url: `https://github.com/${fullName}/pull/${number}`, state: "open", merged_at: null, draft: body.draft, body: body.body, head: { ref: body.head, sha: refs.get(`${id}:${body.head}`) }, base: { ref: body.base } };
      pulls.push(pull);
      return reply(201, pull);
    }
    return reply(404, { message: "Not Found" });
  }

  return {
    calls, refs, pulls, tokens, commits,
    failOnce(method, pattern, status) { failures.push({ method, pattern, status }); },
    async outbound(request) {
      try { return await handle(request); }
      catch (error) { return reply(599, { message: `double assertion: ${error.message}` }); }
    },
  };
}

function workerModules() {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  return readdir(root, { recursive: true }).then((entries) => {
    const files = entries.filter((file) => file.endsWith(".js"));
    return {
      modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
      modulesRoot: root,
    };
  });
}

test("simulated GitHub: App auth, webhooks, links and the trusted publisher", { timeout: 180_000 }, async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const gh = fakeGithub(publicKey);
  const mf = new Miniflare({
    ...await workerModules(),
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "github-worker-fixture" },
    r2Buckets: ["FILES"],
    bindings: {
      GITHUB_APP_ID: APP_ID,
      // Stored the way a dashboard secret often arrives: one line, `\n` escaped.
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).trim().replace(/\n/g, "\\n"),
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_APP_SLUG: APP_SLUG,
    },
    outboundService: (request) => gh.outbound(request),
  });
  const origin = "http://localhost";
  const actors = { a: [1001, "student"], b: [1002, "student"], reviewer: [1003, "management"], owner: [1004, "management"], viewer: [1005, "management"], outsider: [1006, "management"], starter: [1007, "management"] };
  const cookie = (actor) => (actor ? `tanyan_session=gh-${actor}; tanyan_persona=${actors[actor][1]}` : "");
  const expectJson = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    return text ? JSON.parse(text) : null;
  };
  const admin = (body, actor = "owner", extra = {}) => mf.dispatchFetch(`${origin}/api/admin/github`, {
    method: "POST", headers: { "content-type": "application/json", origin, cookie: cookie(actor), ...extra }, body: JSON.stringify(body),
  });
  const crGet = (query, actor) => mf.dispatchFetch(`${origin}/api/change-requests?${query}`, { headers: { cookie: cookie(actor) } });
  const crPost = (body, actor, extra = {}) => mf.dispatchFetch(`${origin}/api/change-requests`, {
    method: "POST", headers: { "content-type": "application/json", origin, cookie: cookie(actor), ...extra }, body: JSON.stringify(body),
  });
  const signature = (raw, secret = WEBHOOK_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  let deliveryCounter = 0;
  const webhook = (event, payload, options = {}) => {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    const headers = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": options.deliveryId ?? `delivery-${++deliveryCounter}` };
    if (options.signature !== null) headers["x-hub-signature-256"] = options.signature ?? signature(raw, options.secret);
    return mf.dispatchFetch(`${origin}/api/github/webhook`, { method: "POST", headers, body: raw });
  };

  try {
    const db = await applyD1Migrations(mf);
    const bucket = await mf.getR2Bucket("FILES");
    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('gh-a', '甲', '博士', 2025, '实验', 1), ('gh-b', '乙', '硕士', 2025, '实验', 1),
      ('gh-c', '未安装', '硕士', 2025, '实验', 1), ('gh-d', '未绑定', '硕士', 2025, '实验', 1),
      ('gh-e', '共享', '硕士', 2025, '实验', 1), ('gh-old', '旧安装', '硕士', 2024, '实验', 1)`).run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (1001, 'gh-a-user', '甲', 'student', 'gh-a'), (1002, 'gh-b-user', '乙', 'student', 'gh-b'),
      (1003, 'gh-reviewer', '审核导师', 'mentor', NULL), (1004, 'gh-owner', '超级管理员', 'superadmin', NULL),
      (1005, 'gh-viewer', '只读导师', 'mentor', NULL), (1006, 'gh-outsider', '无关导师', 'mentor', NULL),
      (1007, 'gh-starter', '发起导师', 'mentor', NULL)`).run();
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (1003, 'gh-a', 1, 1), (1005, 'gh-a', 0, 1), (1007, 'gh-a', 1, 1)`).run();
    for (const [actor, [id]] of Object.entries(actors)) {
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").bind(digest(`gh-${actor}`), id).run();
    }
    const bind = (studentId, fullName) => db.prepare(`INSERT INTO student_repository_bindings
      (student_id, github_username, repository_url, repository_full_name, visibility, active, version, last_mutation_id)
      VALUES (?, 'fixture-user', ?, ?, 'private', 1, 1, ?)`).bind(studentId, `https://github.com/${fullName}`, fullName, `bind-${studentId}`).run();
    await bind("gh-a", `${ORG}/study-a`);
    await bind("gh-b", `${ORG}/study-b`);
    await bind("gh-c", `${ORG}/not-installed`);
    await bind("gh-e", `${ORG}/study-a`);
    await db.prepare(`INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (55, 'gone-org', 'Organization')`).run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch)
      VALUES ('gh-old', 5501, 55, 'gone-org/old', 'main')`).run();
    await db.prepare(`INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_agent', 'agent worker', 'agent', ?)`).bind("f".repeat(64)).run();
    await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES
      ('cred_a', 1001, 'codex', 'rnr_agent'), ('cred_b', 1002, 'codex', 'rnr_agent'), ('cred_s', 1007, 'claude', 'rnr_agent')`).run();

    const linkState = async (studentId) => (await db.prepare("SELECT * FROM repository_links WHERE student_id = ?").bind(studentId).first()) ?? null;
    const crRow = (id) => db.prepare("SELECT * FROM change_requests WHERE id = ?").bind(id).first();
    let seeded = 0;
    async function seedChangeRequest({ suffix, studentId = "gh-a", repositoryId = 9001, base = BASE_A, allowed = [], requiresExtraReview = 0, files, requester = 1001, credential = "cred_a" }) {
      seeded += 1;
      const taskId = `task_${suffix}`;
      const attemptId = `att_${suffix}`;
      const id = `cr_${suffix}`;
      const branch = `tanyan/t${suffix}/a${suffix}`;
      await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
        VALUES (?, ?, ?, 'confirmed', 1, 1, ?, ?, ?)`).bind(taskId, studentId, `改进训练脚本 ${suffix}`, requester, `mut_${suffix}`, `mut_${suffix}`).run();
      await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
        allowed_paths_json, protected_paths_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
        VALUES (?, 1, ?, '问题', '说明', '验收', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .bind(taskId, `改进训练脚本 ${suffix}`, JSON.stringify(allowed), JSON.stringify([".github/**", "evaluation/**"]), "e".repeat(64), requester, requester).run();
      await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, model_id, credential_profile_id,
        github_repository_id, base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id)
        VALUES (?, ?, 1, ?, 'codex', 'gpt-5-codex', ?, ?, ?, ?, 'change_ready', ?, ?)`)
        .bind(attemptId, taskId, studentId, credential, repositoryId, base, "c".repeat(64), `idem_${suffix}`, requester).run();
      await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name,
        status, requires_extra_review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, '2026-11-03 08:00:0${seeded % 10}')`)
        .bind(id, taskId, attemptId, studentId, repositoryId, base, branch, requiresExtraReview).run();
      await bucket.put(`agent-attempts/${attemptId}/change.json`, JSON.stringify({ files, unifiedDiff: `diff --git a/${files[0].path} b/${files[0].path}\n` }));
      return { id, taskId, attemptId, branch };
    }
    const modelPy = "print('trained')\n";
    const standardFiles = () => [
      { path: "src/model.py", action: "modify", contentBase64: b64(modelPy), sha256: createHash("sha256").update(modelPy).digest("hex") },
      { path: "scripts/run.sh", action: "add", contentBase64: b64("#!/bin/sh\necho run\n"), mode: "100755" },
      { path: "old/obsolete.txt", action: "delete" },
      { path: "assets/weights.bin", action: "add", contentBase64: Buffer.from([0, 1, 2, 255]).toString("base64") },
    ];

    await t.test("admin endpoints are superadmin-only and never accept client repository IDs (T03)", async () => {
      for (const actor of ["a", "reviewer", "viewer"]) await expectJson(await admin({ action: "sync_installations" }, actor), 403);
      await expectJson(await admin({ action: "sync_installations" }, null), 401);
      await expectJson(await admin({ action: "sync_installations" }, "owner", { origin: "https://evil.example" }), 403);
      const before = gh.calls.length;
      await expectJson(await admin({ action: "link_repository", studentId: "gh-a", repositoryId: 9100 }), 400);
      await expectJson(await admin({ action: "link_repository", studentId: "gh-a", installationId: 88 }), 400);
      assert.equal(gh.calls.length, before, "rejected requests never reach GitHub");
      const state = await expectJson(await mf.dispatchFetch(`${origin}/api/admin/github`, { headers: { cookie: cookie("owner") } }));
      assert.deepEqual(state.configured, { app: true, webhook: true });
    });

    await t.test("sync records installations and revokes links of installations GitHub no longer reports", async () => {
      const data = await expectJson(await admin({ action: "sync_installations" }));
      assert.equal(data.result.synced, 2);
      const rows = (await db.prepare("SELECT installation_id, account_login, status FROM github_installations ORDER BY installation_id").all()).results;
      assert.deepEqual(rows, [
        { installation_id: 55, account_login: "gone-org", status: "deleted" },
        { installation_id: 77, account_login: ORG, status: "active" },
        { installation_id: 88, account_login: "other-org", status: "active" },
      ]);
      assert.equal((await linkState("gh-old")).status, "revoked");
      assert.deepEqual(gh.calls.at(-1), { method: "GET", path: "/app/installations?per_page=100&page=1", body: undefined, auth: "jwt" });
    });

    await t.test("link_repository resolves the bound full name to a stable ID through the installation", async () => {
      gh.calls.length = 0;
      const data = await expectJson(await admin({ action: "link_repository", studentId: "gh-a" }));
      assert.deepEqual(data.result, { studentId: "gh-a", repositoryId: 9001, installationId: 77, fullName: `${ORG}/study-a`, defaultBranch: "main" });
      assert.deepEqual(gh.calls.map((call) => `${call.method} ${call.path} ${call.auth}`), [
        `GET /repos/${ORG}/study-a/installation jwt`,
        "POST /app/installations/77/access_tokens jwt",
        `GET /repos/${ORG}/study-a token`,
      ]);
      assert.deepEqual(gh.calls[1].body, { repositories: ["study-a"], permissions: { metadata: "read" } });
      const link = await linkState("gh-a");
      assert.equal(link.status, "active");
      assert.equal(link.verified_by_user_id, 1004);
      assert.equal((await expectJson(await admin({ action: "link_repository", studentId: "gh-b" }))).result.defaultBranch, "trunk");
      await expectJson(await admin({ action: "link_repository", studentId: "gh-d" }), 400);
      await expectJson(await admin({ action: "link_repository", studentId: "gh-c" }), 409);
      const shared = await expectJson(await admin({ action: "link_repository", studentId: "gh-e" }), 409);
      assert.match(shared.error, /其他学生/);
      assert.equal(await linkState("gh-c"), null);
      assert.equal(await linkState("gh-e"), null);
    });

    await t.test("read path: contents:read token for one repository resolves branch and SHA (T02 simulated)", async () => {
      gh.calls.length = 0;
      const head = await expectJson(await admin({ action: "check_access", studentId: "gh-a" }));
      assert.deepEqual(head.result, { studentId: "gh-a", repositoryId: 9001, fullName: `${ORG}/study-a`, ref: "main", commitSha: BASE_A });
      assert.deepEqual(gh.calls[0].body, { repository_ids: [9001], permissions: { contents: "read" } });
      assert.ok(!JSON.stringify(head).includes("ghs_"), "tokens are never returned to clients");
      assert.equal((await expectJson(await admin({ action: "check_access", studentId: "gh-a", ref: BASE_A.toUpperCase() }))).result.commitSha, BASE_A);
      await expectJson(await admin({ action: "check_access", studentId: "gh-a", ref: "f".repeat(40) }), 400);
      await expectJson(await admin({ action: "check_access", studentId: "gh-a", ref: "missing-branch" }), 400);
      // A SHA that exists only in another student's repository is not found here.
      await expectJson(await admin({ action: "check_access", studentId: "gh-a", ref: BASE_B }), 400);
      const calls = gh.calls.length;
      await expectJson(await admin({ action: "check_access", studentId: "gh-a", ref: "../main" }), 400);
      assert.equal(gh.calls.length, calls, "invalid refs are rejected before any token is minted");
    });

    await t.test("revoke_link and relink keep one row per student", async () => {
      await expectJson(await admin({ action: "revoke_link", studentId: "gh-b" }));
      assert.equal((await linkState("gh-b")).status, "revoked");
      await expectJson(await admin({ action: "revoke_link", studentId: "gh-b" }), 409);
      await expectJson(await admin({ action: "check_access", studentId: "gh-b" }), 409);
      await expectJson(await admin({ action: "link_repository", studentId: "gh-b" }));
      assert.equal((await linkState("gh-b")).status, "active");
    });

    const deliveries = async () => (await db.prepare("SELECT count(*) AS n FROM github_webhook_deliveries").first()).n;

    await t.test("webhook signatures are verified over the raw body before parsing (T07)", async () => {
      // GitHub's documented vector: valid signature, but not JSON → 400, not 401.
      const vector = await webhook("ping", "Hello, World!", { signature: "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17" });
      assert.equal(vector.status, 400, await vector.text());
      const payload = JSON.stringify({ zen: "ok", hook_id: 1 });
      for (const options of [
        { signature: null },
        { signature: "sha256=" + "0".repeat(64) },
        { signature: signature(payload).replace("sha256=", "sha1=") },
        { signature: signature(payload).toUpperCase().replace("SHA256=", "sha256=").slice(0, -1) },
        { secret: "wrong secret" },
        { signature: signature(payload + " ") },
      ]) {
        await expectJson(await webhook("ping", payload, options), 401);
      }
      assert.equal(await deliveries(), 0, "unsigned or forged deliveries are never recorded");
      const ok = await expectJson(await webhook("ping", payload));
      assert.equal(ok.status, "ignored");
      await expectJson(await webhook("ping", payload, { deliveryId: "bad id with spaces" }), 400);
    });

    await t.test("installation_repositories removal revokes links and a replay has no side effects (T06)", async () => {
      const removal = { action: "removed", installation: { id: 77 }, repository_selection: "selected", repositories_removed: [{ id: 9002, full_name: `${ORG}/study-b` }], sender: { login: "org-admin", type: "User" } };
      const first = await expectJson(await webhook("installation_repositories", removal, { deliveryId: "dedupe-1" }));
      assert.equal(first.status, "processed");
      assert.equal((await linkState("gh-b")).status, "revoked");
      assert.equal((await linkState("gh-a")).status, "active", "other repositories of the installation are untouched");
      await expectJson(await admin({ action: "link_repository", studentId: "gh-b" }));
      const count = await deliveries();
      const replay = await expectJson(await webhook("installation_repositories", removal, { deliveryId: "dedupe-1" }));
      assert.deepEqual(replay, { ok: true, duplicate: true });
      assert.equal((await linkState("gh-b")).status, "active", "the replay did not revoke the relinked repository again");
      assert.equal(await deliveries(), count);
      // A removal reported by another installation cannot revoke this link.
      await expectJson(await webhook("installation_repositories", { ...removal, installation: { id: 88 } }));
      assert.equal((await linkState("gh-b")).status, "active");
      const stored = await db.prepare("SELECT event, action, installation_id, origin, status, summary_json, payload_sha256 FROM github_webhook_deliveries WHERE delivery_id = 'dedupe-1'").first();
      assert.equal(stored.status, "processed");
      assert.match(stored.payload_sha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(JSON.parse(stored.summary_json), { action: "removed", installationId: 77, repositoryId: null, repositoriesRemoved: [9002] });
    });

    await t.test("installation events from another App are isolated", async () => {
      const result = await expectJson(await webhook("installation", { action: "deleted", installation: { id: 77, app_id: 999, account: { login: ORG, type: "Organization" } } }));
      assert.equal(result.reason, "app_mismatch");
      assert.equal((await db.prepare("SELECT status FROM github_installations WHERE installation_id = 77").first()).status, "active");
      assert.equal((await linkState("gh-a")).status, "active");
    });

    const a = await seedChangeRequest({ suffix: "happy0001", files: standardFiles() });
    const b = await seedChangeRequest({ suffix: "bstud0001", studentId: "gh-b", repositoryId: 9002, base: BASE_B, files: standardFiles(), requester: 1002, credential: "cred_b" });

    await t.test("change requests are scoped to the student and their reviewers (T01/T03)", async () => {
      const before = JSON.stringify(await crRow(a.id));
      await expectJson(await crGet(`changeRequestId=${a.id}`, "b"), 404);
      await expectJson(await crGet(`taskId=${a.taskId}`, "b"), 404);
      await expectJson(await crGet(`changeRequestId=${a.id}`, "outsider"), 404);
      await expectJson(await crGet(`changeRequestId=${a.id}`, null), 401);
      await expectJson(await crPost({ action: "publish", changeRequestId: a.id, expectedVersion: 1 }, "b"), 404);
      await expectJson(await crPost({ action: "reject", changeRequestId: a.id, expectedVersion: 1 }, "b"), 404);
      await expectJson(await crPost({ action: "publish", changeRequestId: a.id, expectedVersion: 1 }, "a", { origin: "https://evil.example" }), 403);
      const viewer = await expectJson(await crGet(`changeRequestId=${a.id}`, "viewer"));
      assert.deepEqual(viewer.permissions, { canPublish: false, canApproveExtraReview: false, canReject: false });
      await expectJson(await crPost({ action: "publish", changeRequestId: a.id, expectedVersion: 1 }, "viewer"), 403);
      await expectJson(await crPost({ action: "publish", changeRequestId: b.id, expectedVersion: 1 }, "a"), 404);
      await expectJson(await crPost({ action: "publish", changeRequestId: "cr_doesnotexist", expectedVersion: 1 }, "owner"), 404);
      await expectJson(await crPost({ action: "publish", changeRequestId: a.id, expectedVersion: "1" }, "a"), 400);
      assert.equal(JSON.stringify(await crRow(a.id)), before);
      const own = await expectJson(await crGet(`changeRequestId=${a.id}`, "a"));
      assert.equal(own.changeRequest.status, "pending_review");
      assert.deepEqual(own.change.paths.map((item) => item.path), ["src/model.py", "scripts/run.sh", "old/obsolete.txt", "assets/weights.bin"]);
      assert.equal(own.permissions.canPublish, true);
      assert.equal((await expectJson(await crGet(`taskId=${a.taskId}`, "reviewer"))).changeRequests.length, 1);
    });

    await t.test("publish creates blobs → tree → commit → ref → Draft PR with exact payloads (T04 platform side)", async () => {
      gh.calls.length = 0;
      await expectJson(await crPost({ action: "publish", changeRequestId: a.id, expectedVersion: 2 }, "a"), 409);
      const data = await expectJson(await crPost({ action: "publish", changeRequestId: a.id, expectedVersion: 1 }, "a"));
      const repo = `/repos/${ORG}/study-a`;
      assert.deepEqual(gh.calls.map((call) => `${call.method} ${call.path}`), [
        "POST /app/installations/77/access_tokens",
        `GET ${repo}/git/commits/${BASE_A}`,
        `POST ${repo}/git/blobs`,
        `POST ${repo}/git/trees`,
        `POST ${repo}/git/commits`,
        `GET ${repo}/git/ref/heads/${a.branch}`,
        `POST ${repo}/git/refs`,
        `GET ${repo}/pulls?state=all&per_page=20&head=${encodeURIComponent(`${ORG}:${a.branch}`)}`,
        `POST ${repo}/pulls`,
      ]);
      const [token, , blob, tree, commit, , ref, , pull] = gh.calls;
      assert.equal(token.auth, "jwt");
      assert.ok(gh.calls.slice(1).every((call) => call.auth === "token"));
      assert.deepEqual(token.body, { repository_ids: [9001], permissions: { contents: "write", pull_requests: "write" } });
      // Only the binary file needs a blob call; UTF-8 text is inlined in the tree.
      assert.deepEqual(blob.body, { content: Buffer.from([0, 1, 2, 255]).toString("base64"), encoding: "base64" });
      assert.deepEqual(tree.body, {
        base_tree: TREE_A,
        tree: [
          { path: "assets/weights.bin", mode: "100644", type: "blob", sha: sha1(`blob:${blob.body.content}`) },
          { path: "old/obsolete.txt", mode: "100644", type: "blob", sha: null },
          { path: "scripts/run.sh", mode: "100755", type: "blob", content: "#!/bin/sh\necho run\n" },
          { path: "src/model.py", mode: "100644", type: "blob", content: modelPy },
        ],
      });
      assert.deepEqual(commit.body.parents, [BASE_A]);
      assert.equal(commit.body.tree, sha1(`tree:${JSON.stringify(tree.body)}`));
      assert.equal(commit.body.message, [
        "改进训练脚本 happy0001", "", "由探研平台可信发布服务根据已确认的研究任务创建。", "",
        `Tanyan-Task: ${a.taskId}`, `Tanyan-Attempt: ${a.attemptId}`, "Assisted-by: codex:gpt-5-codex",
      ].join("\n"));
      assert.deepEqual(commit.body.author, commit.body.committer);
      assert.match(commit.body.author.date, /^2026-11-03T08:00:0\dZ$/);
      const commitSha = sha1(`commit:${JSON.stringify(commit.body)}`);
      assert.deepEqual(ref.body, { ref: `refs/heads/${a.branch}`, sha: commitSha });
      assert.equal(pull.body.draft, true);
      assert.equal(pull.body.base, "main");
      assert.equal(pull.body.head, a.branch);
      assert.equal(pull.body.maintainer_can_modify, false);
      assert.ok(pull.body.body.startsWith("<!-- tanyan:origin=platform -->\n"));
      assert.equal(gh.refs.get("9001:main"), BASE_A, "the default branch is never written");
      assert.equal(data.changeRequest.status, "open");
      assert.equal(data.changeRequest.prNumber, 1);
      assert.equal(data.changeRequest.prUrl, `https://github.com/${ORG}/study-a/pull/1`);
      assert.equal(data.changeRequest.headCommitSha, commitSha);
      assert.equal(data.changeRequest.publishedByUserId, 1001);
      assert.match((await crRow(a.id)).published_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, "the PR open time is recorded (schema 28)");
      assert.deepEqual(data.publish, { reusedRef: false, reusedPullRequest: false });
      await expectJson(await crPost({ action: "publish", changeRequestId: a.id, expectedVersion: data.changeRequest.version }, "a"), 409);
    });

    const prPayload = (overrides = {}) => ({
      action: "closed", number: 1, installation: { id: 77 }, repository: { id: 9001, full_name: `${ORG}/study-a` },
      sender: { login: "mentor-human", type: "User" },
      pull_request: { number: 1, merged: true, body: "<!-- tanyan:origin=platform -->\n人工合并", head: { ref: a.branch, sha: "c3".repeat(20) } },
      ...overrides,
    });

    await t.test("platform echoes and mismatched installations or repositories are isolated (T07/T08)", async () => {
      const snapshot = JSON.stringify(await crRow(a.id));
      const opened = await expectJson(await webhook("pull_request", prPayload({ action: "opened", pull_request: { ...prPayload().pull_request, merged: false } })));
      assert.deepEqual([opened.status, opened.origin], ["ignored", "platform_echo"]);
      const bot = await expectJson(await webhook("pull_request", prPayload({ sender: { login: `${APP_SLUG}[bot]`, type: "Bot" } })));
      assert.deepEqual([bot.status, bot.origin], ["ignored", "platform_echo"]);
      const wrongInstallation = await expectJson(await webhook("pull_request", prPayload({ installation: { id: 88 } })));
      assert.equal(wrongInstallation.reason, "installation_mismatch");
      const wrongRepository = await expectJson(await webhook("pull_request", prPayload({ repository: { id: 9100 } })));
      assert.equal(wrongRepository.reason, "unknown_pull_request");
      const wrongBranch = await expectJson(await webhook("pull_request", prPayload({ pull_request: { ...prPayload().pull_request, head: { ref: "feature/x", sha: "c3".repeat(20) } } })));
      assert.equal(wrongBranch.reason, "branch_mismatch");
      assert.equal(JSON.stringify(await crRow(a.id)), snapshot, "isolated events change nothing");
      const echoes = (await db.prepare("SELECT count(*) AS n FROM github_webhook_deliveries WHERE origin = 'platform_echo'").first()).n;
      assert.equal(echoes, 2);
      const stored = (await db.prepare("SELECT summary_json FROM github_webhook_deliveries WHERE event = 'pull_request'").all()).results;
      assert.ok(stored.every((row) => !row.summary_json.includes("人工合并") && !row.summary_json.includes("tanyan:origin")), "only a minimal summary is stored");
    });

    await t.test("pull_request synchronize and merge update the change request exactly once", async () => {
      const newHead = "d4".repeat(20);
      await expectJson(await webhook("pull_request", prPayload({ action: "synchronize", pull_request: { ...prPayload().pull_request, merged: false, head: { ref: a.branch, sha: newHead } } })));
      assert.equal((await crRow(a.id)).head_commit_sha, newHead);
      const version = (await crRow(a.id)).version;
      await expectJson(await webhook("pull_request", prPayload(), { deliveryId: "merge-1" }));
      const merged = await crRow(a.id);
      assert.equal(merged.status, "merged");
      assert.equal(merged.version, version + 1);
      assert.deepEqual(await expectJson(await webhook("pull_request", prPayload(), { deliveryId: "merge-1" })), { ok: true, duplicate: true });
      assert.equal((await crRow(a.id)).version, version + 1);
    });

    await t.test("protected paths block publishing until a reviewer approves extra review (T05)", async () => {
      const files = [{ path: ".github/workflows/ci.yml", action: "modify", contentBase64: b64("on: push\n") }, { path: "src/train.py", action: "add", contentBase64: b64("x = 1\n") }];
      const flagged = await seedChangeRequest({ suffix: "prot00001", requiresExtraReview: 1, files });
      gh.calls.length = 0;
      const blocked = await expectJson(await crPost({ action: "publish", changeRequestId: flagged.id, expectedVersion: 1 }, "a"), 409);
      assert.equal(blocked.code, "EXTRA_REVIEW_REQUIRED");
      await expectJson(await crPost({ action: "publish", changeRequestId: flagged.id, expectedVersion: 1 }, "reviewer"), 409);
      assert.equal(gh.calls.length, 0, "no GitHub call before approval");
      await expectJson(await crPost({ action: "approve_extra_review", changeRequestId: flagged.id, expectedVersion: 1 }, "a"), 403);
      await expectJson(await crPost({ action: "approve_extra_review", changeRequestId: flagged.id, expectedVersion: 1 }, "viewer"), 403);
      const approved = await expectJson(await crPost({ action: "approve_extra_review", changeRequestId: flagged.id, expectedVersion: 1 }, "reviewer"));
      assert.equal(approved.changeRequest.extraReviewApprovedByUserId, 1003);
      await expectJson(await crPost({ action: "approve_extra_review", changeRequestId: flagged.id, expectedVersion: 2 }, "reviewer"), 409);
      const published = await expectJson(await crPost({ action: "publish", changeRequestId: flagged.id, expectedVersion: 2 }, "a"));
      assert.equal(published.changeRequest.status, "open");
      assert.match(gh.pulls.at(-1).body, /受保护路径：1 个，已通过额外审查/);

      // A reviewer cannot approve extra review for an attempt they started.
      const selfStarted = await seedChangeRequest({ suffix: "self00001", requiresExtraReview: 1, files, requester: 1007, credential: "cred_s" });
      await expectJson(await crPost({ action: "approve_extra_review", changeRequestId: selfStarted.id, expectedVersion: 1 }, "starter"), 403);

      // The publisher re-checks paths even when the stored flag is missing.
      const unflagged = await seedChangeRequest({ suffix: "unfl00001", files: [{ path: "evaluation/metric.py", action: "modify", contentBase64: b64("pass\n") }] });
      gh.calls.length = 0;
      const caught = await expectJson(await crPost({ action: "publish", changeRequestId: unflagged.id, expectedVersion: 1 }, "a"), 409);
      assert.equal(caught.code, "PUBLISH_BLOCKED");
      assert.equal(caught.changeRequest.status, "pending_review");
      assert.equal(caught.changeRequest.requiresExtraReview, true);
      assert.equal(gh.calls.length, 0);
    });

    await t.test("paths outside the task's allowed scope are rejected before any GitHub write (T04)", async () => {
      const scoped = await seedChangeRequest({ suffix: "scop00001", allowed: ["src/**"], files: [
        { path: "src/ok.py", action: "add", contentBase64: b64("ok\n") }, { path: "README.md", action: "modify", contentBase64: b64("x\n") },
      ] });
      gh.calls.length = 0;
      const rejected = await expectJson(await crPost({ action: "publish", changeRequestId: scoped.id, expectedVersion: 1 }, "a"), 422);
      assert.equal(rejected.code, "POLICY_VIOLATION");
      assert.match(rejected.error, /README\.md/);
      assert.equal(rejected.changeRequest.status, "rejected");
      assert.equal(gh.calls.length, 0);
      const traversal = await seedChangeRequest({ suffix: "trav00001", files: [{ path: "src/../.git/config", action: "add", contentBase64: b64("x") }] });
      assert.equal((await expectJson(await crPost({ action: "publish", changeRequestId: traversal.id, expectedVersion: 1 }, "a"), 422)).changeRequest.status, "rejected");
      const tampered = await seedChangeRequest({ suffix: "tamp00001", files: [{ path: "src/x.py", action: "add", contentBase64: b64("x"), sha256: "0".repeat(64) }] });
      await expectJson(await crPost({ action: "publish", changeRequestId: tampered.id, expectedVersion: 1 }, "a"), 422);
      assert.equal(gh.calls.length, 0);
    });

    await t.test("a publish interrupted mid-way resumes without a second ref or PR", async () => {
      const retry = await seedChangeRequest({ suffix: "retr00001", files: standardFiles() });
      gh.failOnce("POST", /\/pulls$/, 500);
      gh.calls.length = 0;
      const failed = await expectJson(await crPost({ action: "publish", changeRequestId: retry.id, expectedVersion: 1 }, "reviewer"), 502);
      assert.equal(failed.code, "GITHUB_ERROR");
      assert.equal(failed.changeRequest.status, "failed");
      const firstHead = gh.refs.get(`9001:${retry.branch}`);
      assert.ok(firstHead);
      assert.equal(failed.changeRequest.headCommitSha, firstHead);
      gh.calls.length = 0;
      const resumed = await expectJson(await crPost({ action: "publish", changeRequestId: retry.id, expectedVersion: failed.changeRequest.version }, "a"));
      assert.equal(resumed.changeRequest.status, "open");
      assert.deepEqual(resumed.publish, { reusedRef: true, reusedPullRequest: false });
      assert.equal(gh.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs")).length, 0, "the existing ref is reused, not recreated");
      assert.equal(gh.refs.get(`9001:${retry.branch}`), firstHead, "deterministic commit: same head after retry");
      assert.equal(gh.pulls.filter((pull) => pull.head.ref === retry.branch).length, 1);

      // A worker that died while `publishing` can be resumed by a new publish.
      const stuck = await seedChangeRequest({ suffix: "stuc00001", files: standardFiles() });
      await expectJson(await crPost({ action: "publish", changeRequestId: stuck.id, expectedVersion: 1 }, "a"));
      await db.prepare("UPDATE change_requests SET status = 'publishing', version = version + 1 WHERE id = ?").bind(stuck.id).run();
      const again = await expectJson(await crPost({ action: "publish", changeRequestId: stuck.id, expectedVersion: (await crRow(stuck.id)).version }, "a"));
      assert.deepEqual(again.publish, { reusedRef: true, reusedPullRequest: true });
      assert.equal(gh.pulls.filter((pull) => pull.head.ref === stuck.branch).length, 1);
    });

    await t.test("a branch that already points elsewhere is a conflict and is never overwritten", async () => {
      const conflict = await seedChangeRequest({ suffix: "conf00001", files: standardFiles() });
      const foreign = "e5".repeat(20);
      gh.refs.set(`9001:${conflict.branch}`, foreign);
      gh.calls.length = 0;
      const result = await expectJson(await crPost({ action: "publish", changeRequestId: conflict.id, expectedVersion: 1 }, "a"), 409);
      assert.equal(result.code, "BRANCH_CONFLICT");
      assert.equal(result.changeRequest.status, "failed");
      assert.equal(gh.refs.get(`9001:${conflict.branch}`), foreign);
      assert.ok(!gh.calls.some((call) => call.method !== "GET" && /\/git\/refs/.test(call.path)));
      assert.ok(!gh.calls.some((call) => call.method === "POST" && call.path.endsWith("/pulls")));
    });

    await t.test("reject is limited to actionable states and to the owner or reviewers", async () => {
      const victim = await seedChangeRequest({ suffix: "rejc00001", files: standardFiles() });
      await expectJson(await crPost({ action: "reject", changeRequestId: victim.id, expectedVersion: 1 }, "viewer"), 403);
      const rejected = await expectJson(await crPost({ action: "reject", changeRequestId: victim.id, expectedVersion: 1 }, "reviewer"));
      assert.equal(rejected.changeRequest.status, "rejected");
      await expectJson(await crPost({ action: "publish", changeRequestId: victim.id, expectedVersion: 2 }, "a"), 409);
      await expectJson(await crPost({ action: "unknown", changeRequestId: victim.id, expectedVersion: 2 }, "a"), 400);
    });

    await t.test("removing the repository from the installation revokes the link and blocks publishing", async () => {
      const pending = await seedChangeRequest({ suffix: "revk00001", files: standardFiles() });
      await expectJson(await webhook("installation_repositories", { action: "removed", installation: { id: 77 }, repositories_removed: [{ id: 9001 }] }));
      assert.equal((await linkState("gh-a")).status, "revoked");
      gh.calls.length = 0;
      const blocked = await expectJson(await crPost({ action: "publish", changeRequestId: pending.id, expectedVersion: 1 }, "a"), 409);
      assert.equal(blocked.code, "PUBLISH_BLOCKED");
      assert.equal(gh.calls.length, 0);
      const deleted = await expectJson(await webhook("installation", { action: "deleted", installation: { id: 77, app_id: Number(APP_ID), account: { login: ORG, type: "Organization" } } }));
      assert.equal(deleted.status, "processed");
      assert.equal((await linkState("gh-b")).status, "revoked");
      assert.equal((await db.prepare("SELECT status FROM github_installations WHERE installation_id = 77").first()).status, "deleted");
    });
  } finally {
    await mf.dispose();
  }
});

test("simulated GitHub: endpoints fail closed when the App is not configured", { timeout: 120_000 }, async () => {
  let outbound = 0;
  const mf = new Miniflare({
    ...await workerModules(),
    compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "github-unconfigured-fixture" }, r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("no external services", { status: 502 }); },
  });
  try {
    const db = await applyD1Migrations(mf);
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role) VALUES (2001, 'gh-unconf-owner', '超级管理员', 'superadmin')`).run();
    await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, 2001, datetime('now', '+1 day'))").bind(digest("gh-unconf")).run();
    const headers = { "content-type": "application/json", origin: "http://localhost", cookie: "tanyan_session=gh-unconf; tanyan_persona=management" };
    const sync = await mf.dispatchFetch("http://localhost/api/admin/github", { method: "POST", headers, body: JSON.stringify({ action: "sync_installations" }) });
    assert.equal(sync.status, 503);
    assert.equal((await sync.json()).code, "GITHUB_NOT_CONFIGURED");
    const state = await (await mf.dispatchFetch("http://localhost/api/admin/github", { headers })).json();
    assert.deepEqual(state.configured, { app: false, webhook: false });
    const hook = await mf.dispatchFetch("http://localhost/api/github/webhook", {
      method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": "d-1", "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body: "{}",
    });
    assert.equal(hook.status, 503);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM github_webhook_deliveries").first()).n, 0);
    assert.equal(outbound, 0);
  } finally { await mf.dispose(); }
});
