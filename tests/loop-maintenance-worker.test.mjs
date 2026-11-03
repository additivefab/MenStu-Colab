import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { issueRunnerToken } from "../lib/lab-runner-auth.ts";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// G2 compensating reconciliation (lib/loop-maintenance.ts) against the built
// Worker: the cron `scheduled()` handler and POST /api/admin/maintenance.
// Everything is synthetic: GitHub and Feishu are doubles behind Miniflare's
// outboundService (fixture credentials only).

const ORIGIN = "http://localhost";
const PUBLIC_ORIGIN = "https://lab.example.test";
const FEISHU = { FEISHU_APP_ID: "cli_0000000000000002", FEISHU_APP_SECRET: "test-only-maintenance-secret" };
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id";
const SPEC = "a".repeat(64);
const BASE_SHA = "b".repeat(40);
const OLD_HEAD = "c".repeat(40);
const NEW_HEAD = "d".repeat(40);
const MERGED_HEAD = "e".repeat(40);
const MIN = 60_000;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function workerModules() {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  return readdir(root, { recursive: true }).then((all) => {
    const files = all.filter((file) => file.endsWith(".js"));
    return {
      modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })),
      modulesRoot: root,
    };
  });
}

const USERS = {
  root: { id: 1001, openId: "ou_maint_root_00001", role: "superadmin" },
  mentor: { id: 1002, openId: "ou_maint_mentor_0001", role: "mentor" },
  student: { id: 1003, openId: "ou_maint_student_001", role: "student", studentId: "nt-m" },
};

/** Students, users, sessions, a task, a lab runner pair and one run spec. */
async function seedBase(db, prefix) {
  await db.prepare("INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES ('nt-m', '合成学生', '博士', 2025, '实验', 1)").run();
  for (const [key, user] of Object.entries(USERS)) {
    await db.prepare("INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id, active) VALUES (?, ?, ?, ?, ?, 1)")
      .bind(user.id, user.openId, `合成${key}`, user.role, user.studentId ?? null).run();
    await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
      .bind(digest(`${prefix}-${key}`), user.id).run();
  }
  await db.prepare("INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES (1002, 'nt-m', 1, 1)").run();
  const compute = await issueRunnerToken();
  const agent = await issueRunnerToken();
  await db.prepare(`INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES
    ('rnr_m_compute', '计算', 'compute', ?), ('rnr_m_agent', '代理', 'agent', ?)`).bind(compute.tokenSha256, agent.tokenSha256).run();
  await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
    VALUES ('task_m1', 'nt-m', '对账任务', 'confirmed', 1, 1, 1002, 'mut-m1-create', 'mut-m1-last')`).run();
  await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria, snapshot_sha256, author_user_id)
    VALUES ('task_m1', 1, '对账任务', '问题', '说明', '标准', ?, 1002)`).bind("f".repeat(64)).run();
  await db.prepare(`INSERT INTO registered_entrypoints(id, github_repository_id, name, argv_json, image_ref, created_by_user_id)
    VALUES ('ep_m1', 6101, 'train', '["python","train.py"]', 'img', 1001)`).run();
  await db.prepare(`INSERT INTO dataset_versions(id, label, runner_id, manifest_sha256, egress_policy_json, created_by_user_id)
    VALUES ('ds_m1', '数据', 'rnr_m_compute', ?, '{}', 1001)`).bind("1".repeat(64)).run();
  await db.prepare(`INSERT INTO run_specs(sha256, canonical_json, task_id, task_version, student_id, github_repository_id, executed_commit_sha, entrypoint_id, dataset_version_id, created_by_user_id)
    VALUES (?, '{}', 'task_m1', 1, 'nt-m', 6101, ?, 'ep_m1', 'ds_m1', 1002)`).bind(SPEC, BASE_SHA).run();
  await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_m1', 1003, 'codex', 'rnr_m_agent')`).run();
  return { compute: compute.token, agent: agent.token };
}

let runNumber = 0;
async function insertRun(db, id, fields) {
  runNumber += 1;
  const row = { status: "running", runner_id: "rnr_m_compute", lease_epoch: 1, lease_expires_at: null, heartbeat_at: null,
    cancel_requested_at: null, started_at: null, ended_at: null, ...fields };
  await db.prepare(`INSERT INTO runs(id, run_spec_sha256, attempt, task_id, student_id, status, idempotency_key, submit_tag, runner_id,
      lease_epoch, lease_expires_at, heartbeat_at, cancel_requested_at, created_by_user_id, started_at, ended_at)
    VALUES (?, ?, ?, 'task_m1', 'nt-m', ?, ?, ?, ?, ?, ?, ?, ?, 1002, ?, ?)`)
    .bind(id, SPEC, runNumber, row.status, `idem-${id}`, `tag-${id}`, row.runner_id, row.lease_epoch, row.lease_expires_at,
      row.heartbeat_at, row.cancel_requested_at, row.started_at, row.ended_at).run();
}

async function insertAttempt(db, id, fields) {
  const row = { status: "running", worker_id: "rnr_m_agent", lease_epoch: 1, lease_expires_at: null, heartbeat_at: null, cancel_requested_at: null, ...fields };
  await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
      base_commit_sha, context_snapshot_sha256, status, worker_id, lease_epoch, lease_expires_at, heartbeat_at, idempotency_key,
      requested_by_user_id, cancel_requested_at)
    VALUES (?, 'task_m1', 1, 'nt-m', 'codex', 'cred_m1', 6101, ?, ?, ?, ?, ?, ?, ?, ?, 1003, ?)`)
    .bind(id, BASE_SHA, "2".repeat(64), row.status, row.worker_id, row.lease_epoch, row.lease_expires_at, row.heartbeat_at,
      `idem-${id}`, row.cancel_requested_at).run();
}

async function insertChangeRequest(db, id, fields) {
  await insertAttempt(db, `att_${id}`, { status: "change_ready", lease_expires_at: null });
  const row = { status: "open", pr_number: null, head_commit_sha: OLD_HEAD, branch_name: `tanyan/m/${id}`, ...fields };
  await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name,
      head_commit_sha, pr_number, status, version, updated_at)
    VALUES (?, 'task_m1', ?, 'nt-m', 6101, ?, ?, ?, ?, ?, 3, ?)`)
    .bind(id, `att_${id}`, BASE_SHA, row.branch_name, row.head_commit_sha, row.pr_number, row.status, row.updated_at).run();
}

async function insertNotification(db, eventKey, fields) {
  const row = { recipient: USERS.student.id, status: "failed", attempts: 1, ...fields };
  await db.prepare(`INSERT INTO loop_notifications(event_key, recipient_user_id, channel, status, attempts, last_error, created_at)
    VALUES (?, ?, 'feishu', ?, ?, '发送超时', ?)`).bind(eventKey, row.recipient, row.status, row.attempts, row.created_at).run();
}

/** Everything maintenance may write, for before/after comparisons. */
async function snapshot(db) {
  const all = async (sql) => (await db.prepare(sql).all()).results;
  return {
    runs: await all("SELECT id, status, lease_epoch, lease_expires_at, failure_reason, ended_at FROM runs ORDER BY id"),
    runEvents: await all("SELECT run_id, sequence, from_status, to_status, actor_type, actor_id, payload_json FROM run_events ORDER BY run_id, sequence"),
    attempts: await all("SELECT id, status, error_code, error_message, ended_at FROM agent_attempts ORDER BY id"),
    attemptEvents: await all("SELECT attempt_id, sequence, payload_json FROM agent_attempt_events ORDER BY attempt_id, sequence"),
    changeRequests: await all("SELECT id, status, version, head_commit_sha, pr_number FROM change_requests ORDER BY id"),
    deliveries: await all("SELECT delivery_id, action, status, summary_json FROM github_webhook_deliveries ORDER BY delivery_id"),
    notifications: await all("SELECT event_key, recipient_user_id, status, attempts, last_error FROM loop_notifications ORDER BY event_key, recipient_user_id"),
  };
}

test("loop maintenance: sweeps, thresholds, idempotency, dry run, audit and endpoint auth", { timeout: 300_000 }, async (t) => {
  const NOW = Math.floor(Date.now() / 1000) * 1000;
  const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls = { github: [], feishu: [] };
  const pulls = {
    11: { number: 11, state: "closed", merged: true, merged_at: "2026-11-03T10:00:00Z", head: { ref: "tanyan/m/cr_m_merged", sha: MERGED_HEAD } },
    12: { number: 12, state: "open", merged: false, merged_at: null, head: { ref: "tanyan/m/cr_m_head", sha: NEW_HEAD } },
    13: { number: 13, state: "closed", merged: false, merged_at: null, head: { ref: "tanyan/m/cr_m_recent", sha: NEW_HEAD } },
    14: { number: 14, state: "closed", merged: false, merged_at: null, head: { ref: "tanyan/m/cr_m_closed", sha: OLD_HEAD } },
    15: { number: 15, state: "closed", merged: true, merged_at: "2026-11-03T10:00:00Z", head: { ref: "someone/else", sha: NEW_HEAD } },
  };
  const unexpected = [];
  const mf = new Miniflare({
    ...(await workerModules()),
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "loop-maintenance-fixture" },
    r2Buckets: ["FILES"],
    bindings: { ...FEISHU, PUBLIC_SITE_ORIGIN: PUBLIC_ORIGIN, GITHUB_APP_ID: "434343", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (request.url === FEISHU_TOKEN_URL) return reply(200, { code: 0, tenant_access_token: "t-maint-token" });
      if (request.url === FEISHU_MESSAGE_URL) {
        const body = await request.json();
        const card = JSON.parse(body.content);
        calls.feishu.push({ to: body.receive_id, uuid: body.uuid, line: card.elements[0].text.content, url: card.elements[1]?.actions?.[0]?.url ?? null });
        return reply(200, { code: 0, data: { message_id: `om_${calls.feishu.length}` } });
      }
      if (url.origin === "https://api.github.com") {
        calls.github.push(`${request.method} ${url.pathname}${url.search}`);
        if (request.method === "POST" && url.pathname === "/app/installations/9601/access_tokens") {
          const body = await request.json();
          assert.deepEqual(body, { repository_ids: [6101], permissions: { pull_requests: "read" } });
          return reply(201, { token: "ghs_maint_fixture", expires_at: "2026-11-03T23:00:00Z", repositories: [{ id: 6101, full_name: "maint-lab/nt-m" }] });
        }
        assert.equal(request.headers.get("authorization"), "Bearer ghs_maint_fixture");
        const single = /^\/repos\/maint-lab\/nt-m\/pulls\/(\d+)$/.exec(url.pathname);
        if (request.method === "GET" && single) return pulls[single[1]] ? reply(200, pulls[single[1]]) : reply(404, { message: "Not Found" });
        if (request.method === "GET" && url.pathname === "/repos/maint-lab/nt-m/pulls") {
          assert.equal(url.searchParams.get("head"), "maint-lab:tanyan/m/cr_m_publishing");
          return reply(200, []);
        }
      }
      unexpected.push(`${request.method} ${request.url}`);
      return new Response("No other external services in this test", { status: 502 });
    },
  });

  const cookie = (actor) => `tanyan_session=maint-${actor}; tanyan_persona=${actor === "student" ? "student" : "management"}`;
  const maintenance = (body, { actor, origin = ORIGIN, bearer } = {}) => mf.dispatchFetch(`${ORIGIN}/api/admin/maintenance`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(actor ? { cookie: cookie(actor) } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return JSON.parse(text);
  };
  const scheduled = async (offsetMs = 0) => {
    const worker = await mf.getWorker();
    const result = await worker.scheduled({ cron: "*/10 * * * *", scheduledTime: new Date(NOW + offsetMs) });
    assert.equal(result.outcome, "ok");
  };

  try {
    const db = await applyD1Migrations(mf);
    const tokens = await seedBase(db, "maint");
    await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (9601, 'maint-lab', 'Organization')").run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch)
      VALUES ('nt-m', 6101, 9601, 'maint-lab/nt-m', 'main')`).run();

    // Runs.
    await insertRun(db, "run_m_cancel_old", { status: "cancel_requested", lease_expires_at: at(-31 * MIN), heartbeat_at: at(-31 * MIN), cancel_requested_at: at(-40 * MIN) });
    await insertRun(db, "run_m_cancel_edge", { status: "cancel_requested", lease_expires_at: at(-29 * MIN), heartbeat_at: at(-29 * MIN), cancel_requested_at: at(-29 * MIN) });
    await insertRun(db, "run_m_cancel_leased", { status: "cancel_requested", lease_expires_at: at(5 * MIN), heartbeat_at: at(-40 * MIN), cancel_requested_at: at(-60 * MIN) });
    await insertRun(db, "run_m_cancel_never", { status: "cancel_requested", runner_id: null, lease_epoch: 0, cancel_requested_at: at(-120 * MIN) });
    await insertRun(db, "run_m_stale", { status: "running", lease_expires_at: at(-25 * 60 * MIN), heartbeat_at: at(-25 * 60 * MIN), started_at: at(-26 * 60 * MIN) });
    await insertRun(db, "run_m_quiet", { status: "running", lease_expires_at: at(-23 * 60 * MIN), heartbeat_at: at(-23 * 60 * MIN) });
    await insertRun(db, "run_m_leased", { status: "reconciling", lease_expires_at: at(5 * MIN), heartbeat_at: at(-30 * 60 * MIN) });
    await insertRun(db, "run_m_done", { status: "completed", runner_id: "rnr_m_compute", ended_at: at(-60 * MIN) });
    // Attempts.
    await insertAttempt(db, "att_m_expired", { status: "running", lease_expires_at: at(-1000), heartbeat_at: at(-121_000) });
    await insertAttempt(db, "att_m_valid", { status: "running", lease_expires_at: at(5 * MIN), heartbeat_at: at(-60_000) });
    await insertAttempt(db, "att_m_cancel_old", { status: "cancel_requested", lease_expires_at: at(-33 * MIN), heartbeat_at: at(-35 * MIN), cancel_requested_at: at(-34 * MIN) });
    await insertAttempt(db, "att_m_cancel_new", { status: "cancel_requested", lease_expires_at: at(-8 * MIN), heartbeat_at: at(-10 * MIN), cancel_requested_at: at(-9 * MIN) });
    await insertAttempt(db, "att_m_waiting", { status: "waiting_approval", lease_expires_at: at(-120 * MIN), heartbeat_at: at(-122 * MIN) });
    // Change requests.
    await insertChangeRequest(db, "cr_m_merged", { pr_number: 11, updated_at: at(-20 * MIN) });
    await insertChangeRequest(db, "cr_m_head", { pr_number: 12, updated_at: at(-20 * MIN) });
    await insertChangeRequest(db, "cr_m_recent", { pr_number: 13, updated_at: at(-5 * MIN) });
    await insertChangeRequest(db, "cr_m_closed", { pr_number: 14, updated_at: at(-11 * MIN) });
    await insertChangeRequest(db, "cr_m_mismatch", { pr_number: 15, updated_at: at(-30 * MIN) });
    await insertChangeRequest(db, "cr_m_publishing", { status: "publishing", head_commit_sha: null, updated_at: at(-20 * MIN) });
    await insertChangeRequest(db, "cr_m_pending", { status: "pending_review", updated_at: at(-60 * MIN) });
    // Notifications.
    await insertNotification(db, "run_result_ready:run_m_done", { created_at: at(-60 * MIN) });
    await insertNotification(db, "run_result_ready:run_m_done", { recipient: USERS.mentor.id, attempts: 3, created_at: at(-60 * MIN) });
    await insertNotification(db, "run_awaiting_approval:run_m_done", { recipient: USERS.mentor.id, created_at: at(-25 * 60 * MIN) });
    await insertNotification(db, "run_result_ready:run_m_cancel_old", { created_at: at(-30 * MIN) });

    await t.test("endpoint is superadmin-only, same-origin and private", async () => {
      assert.equal((await json(await maintenance({ action: "dry_run" }), 401)).code, "AUTH_REQUIRED");
      assert.equal((await json(await maintenance({ action: "dry_run" }, { actor: "mentor" }), 403)).code, "FORBIDDEN");
      assert.equal((await json(await maintenance({ action: "dry_run" }, { actor: "student" }), 403)).code, "FORBIDDEN");
      assert.equal((await json(await maintenance({ action: "dry_run" }, { actor: "root", origin: "https://evil.example" }), 403)).code, "FORBIDDEN");
      assert.equal((await json(await maintenance({ action: "purge" }, { actor: "root" }), 400)).code, "INVALID_INPUT");
      assert.equal((await mf.dispatchFetch(`${ORIGIN}/api/admin/maintenance`, { headers: { cookie: cookie("root") } })).status, 405);
      // Lab tokens: an agent worker token is the wrong kind; a compute runner may not finalize.
      assert.equal((await json(await maintenance({ action: "dry_run" }, { bearer: tokens.agent }), 403)).code, "RUNNER_KIND_MISMATCH");
      assert.equal((await json(await maintenance({ action: "run", finalizeStaleRuns: true }, { bearer: tokens.compute }), 403)).code, "FORBIDDEN");
      assert.equal((await json(await maintenance({ action: "run" }, { bearer: "x".repeat(43) }), 401)).code, "RUNNER_AUTH_INVALID");
    });

    await t.test("dry run lists candidates and changes nothing, with no outbound calls", async () => {
      const before = await snapshot(db);
      const { report } = await json(await maintenance({ action: "dry_run" }, { actor: "root" }));
      assert.equal(report.dryRun, true);
      assert.deepEqual(report.runs.cancelFinalized.ids, ["run_m_cancel_never", "run_m_cancel_old"]);
      assert.deepEqual(report.runs.staleAttention.ids, ["run_m_stale"]);
      assert.deepEqual(report.runs.staleFinalized, { count: 0, ids: [] });
      assert.deepEqual(report.agentAttempts.leaseExpiredFailed.ids, ["att_m_expired"]);
      assert.deepEqual(report.agentAttempts.cancelFinalized.ids, ["att_m_cancel_old"]);
      assert.equal(report.changeRequests.skipped, null);
      assert.deepEqual(report.changeRequests.checked.ids, ["cr_m_closed", "cr_m_head", "cr_m_merged", "cr_m_mismatch", "cr_m_publishing"]);
      assert.deepEqual(report.changeRequests.publishingStuck.ids, ["cr_m_publishing"]);
      assert.deepEqual(report.notifications.candidates.ids, ["run_result_ready:run_m_done#1003", "run_result_ready:run_m_cancel_old#1003"]);
      assert.equal(report.notifications.sent.count, 0);
      assert.deepEqual(report.errors, []);
      assert.equal(report.thresholdsMinutes.cancelUnresponsive, 30);
      assert.equal(report.thresholdsMinutes.staleRun, 1440);
      // No content or secrets: only ids and counts.
      assert.doesNotMatch(JSON.stringify(report), /ghs_|t-maint|对账任务|ou_/);
      assert.deepEqual(await snapshot(db), before);
      assert.deepEqual(calls, { github: [], feishu: [] });
    });

    await t.test("cron run applies each sweep at its threshold and writes audit rows", async () => {
      await scheduled(0);
      const status = async (table, id) => (await db.prepare(`SELECT status FROM ${table} WHERE id = ?`).bind(id).first()).status;

      // Step 1: only the lapsed, silent cancel requests end; the edge and the leased one stay.
      assert.equal(await status("runs", "run_m_cancel_old"), "canceled");
      assert.equal(await status("runs", "run_m_cancel_never"), "canceled");
      assert.equal(await status("runs", "run_m_cancel_edge"), "cancel_requested");
      assert.equal(await status("runs", "run_m_cancel_leased"), "cancel_requested");
      const canceled = await db.prepare("SELECT failure_reason, ended_at, lease_expires_at FROM runs WHERE id = 'run_m_cancel_old'").first();
      assert.deepEqual(canceled, { failure_reason: "执行器长时间未响应，平台收尾取消", ended_at: at(0), lease_expires_at: null });
      const events = (await db.prepare("SELECT run_id, sequence, from_status, to_status, actor_type, actor_id, payload_json FROM run_events ORDER BY run_id").all()).results;
      assert.deepEqual(events.map((row) => [row.run_id, row.sequence, row.from_status, row.to_status, row.actor_type, row.actor_id]), [
        ["run_m_cancel_never", 1, "cancel_requested", "canceled", "system", "maintenance"],
        ["run_m_cancel_old", 1, "cancel_requested", "canceled", "system", "maintenance"],
      ]);
      assert.equal(JSON.parse(events[1].payload_json).action, "maintenance_cancel");
      // Step 2: stale in-flight runs are only reported, never failed by default.
      assert.equal(await status("runs", "run_m_stale"), "running");
      assert.equal(await status("runs", "run_m_quiet"), "running");
      assert.equal(await status("runs", "run_m_leased"), "reconciling");

      // Step 3: attempts.
      const attempt = async (id) => db.prepare("SELECT status, error_code, error_message FROM agent_attempts WHERE id = ?").bind(id).first();
      assert.deepEqual(await attempt("att_m_expired"), { status: "failed", error_code: "LEASE_EXPIRED", error_message: "代理工作进程租约过期，未自动重派；如需继续请新建尝试" });
      assert.equal((await attempt("att_m_valid")).status, "running");
      assert.deepEqual(await attempt("att_m_cancel_old"), { status: "canceled", error_code: "LEASE_EXPIRED", error_message: "代理工作进程长时间未响应，平台收尾取消" });
      assert.equal((await attempt("att_m_cancel_new")).status, "cancel_requested");
      assert.equal((await attempt("att_m_waiting")).status, "waiting_approval");
      const audits = (await db.prepare("SELECT attempt_id, sequence, kind, payload_json FROM agent_attempt_events ORDER BY attempt_id").all()).results;
      assert.deepEqual(audits.map((row) => [row.attempt_id, row.sequence, row.kind, JSON.parse(row.payload_json)]), [
        ["att_m_cancel_old", -1, "status", { source: "platform", actor: "system", by: "maintenance", action: "cancel_finalized", from: "cancel_requested", to: "canceled", leaseEpoch: 1 }],
        ["att_m_expired", -1, "status", { source: "platform", actor: "system", by: "maintenance", action: "lease_expired", from: "running", to: "failed", leaseEpoch: 1 }],
      ]);

      // Step 4: change requests follow GitHub with the webhook's mapping.
      const cr = async (id) => db.prepare("SELECT status, version, head_commit_sha, pr_number FROM change_requests WHERE id = ?").bind(id).first();
      assert.deepEqual(await cr("cr_m_merged"), { status: "merged", version: 4, head_commit_sha: MERGED_HEAD, pr_number: 11 });
      assert.deepEqual(await cr("cr_m_head"), { status: "open", version: 4, head_commit_sha: NEW_HEAD, pr_number: 12 });
      assert.deepEqual(await cr("cr_m_closed"), { status: "closed", version: 4, head_commit_sha: OLD_HEAD, pr_number: 14 });
      assert.deepEqual(await cr("cr_m_recent"), { status: "open", version: 3, head_commit_sha: OLD_HEAD, pr_number: 13 }, "refreshed too recently");
      assert.deepEqual(await cr("cr_m_mismatch"), { status: "open", version: 3, head_commit_sha: OLD_HEAD, pr_number: 15 }, "branch mismatch changes nothing");
      assert.deepEqual(await cr("cr_m_publishing"), { status: "publishing", version: 3, head_commit_sha: null, pr_number: null }, "left for re-publish");
      assert.equal((await cr("cr_m_pending")).status, "pending_review");
      const deliveries = (await db.prepare("SELECT delivery_id, event, action, installation_id, repository_id, origin, status, summary_json FROM github_webhook_deliveries ORDER BY delivery_id").all()).results;
      assert.deepEqual(deliveries.map((row) => [row.delivery_id, row.event, row.action, row.installation_id, row.repository_id, row.origin, row.status]), [
        ["maintenance:cr_m_closed:v3", "pull_request", "reconcile_closed", 9601, 6101, "external", "processed"],
        ["maintenance:cr_m_head:v3", "pull_request", "reconcile_synchronize", 9601, 6101, "external", "processed"],
        ["maintenance:cr_m_merged:v3", "pull_request", "reconcile_merged", 9601, 6101, "external", "processed"],
      ]);
      assert.deepEqual(JSON.parse(deliveries[1].summary_json), {
        changeRequestId: "cr_m_head", fromStatus: "open", headSha: NEW_HEAD, prNumber: 12, previousVersion: 3, source: "maintenance", toStatus: "open",
      });
      assert.equal(calls.github.filter((call) => call.startsWith("POST /app/installations/9601/access_tokens")).length, 1, "one token per repository");
      assert.ok(!calls.github.includes("GET /repos/maint-lab/nt-m/pulls/13"));

      // Step 5: only the young, under-limit, still-waiting failure is retried.
      assert.deepEqual(calls.feishu.map((call) => [call.to, call.line]), [[USERS.student.openId, "运行已完成，结果待评审：合成学生 · 任务《对账任务》运行 #8"]]);
      assert.equal(calls.feishu[0].url, `${PUBLIC_ORIGIN}/students/nt-m#research-run-run_m_done`);
      const notifications = (await db.prepare("SELECT event_key, recipient_user_id, status, attempts, last_error FROM loop_notifications ORDER BY event_key, recipient_user_id").all()).results;
      assert.deepEqual(notifications.map((row) => [row.event_key, row.recipient_user_id, row.status, row.attempts]), [
        ["run_awaiting_approval:run_m_done", 1002, "failed", 1],
        ["run_result_ready:run_m_cancel_old", 1003, "failed", 1],
        ["run_result_ready:run_m_done", 1002, "failed", 3],
        ["run_result_ready:run_m_done", 1003, "sent", 2],
      ]);
      assert.deepEqual(unexpected, []);
    });

    await t.test("a second run changes nothing", async () => {
      const before = await snapshot(db);
      const feishuCalls = calls.feishu.length;
      await scheduled(0);
      assert.deepEqual(await snapshot(db), before);
      assert.equal(calls.feishu.length, feishuCalls);
      const { report } = await json(await maintenance({ action: "run" }, { actor: "root" }));
      for (const item of [report.runs.cancelFinalized, report.agentAttempts.leaseExpiredFailed, report.agentAttempts.cancelFinalized,
        report.changeRequests.merged, report.changeRequests.closed, report.changeRequests.headUpdated, report.notifications.sent]) {
        assert.equal(item.count, 0);
      }
      assert.deepEqual(report.runs.staleAttention.ids, ["run_m_stale"], "still reported for attention");
      assert.deepEqual(report.notifications.stale.ids, ["run_result_ready:run_m_cancel_old#1003"]);
      assert.deepEqual(await snapshot(db), before);
    });

    await t.test("threshold edges move with time; valid leases stay untouched", async () => {
      // Two minutes later the 29-minute cancel request has crossed 30 minutes.
      await scheduled(2 * MIN);
      const runStatus = async (id) => (await db.prepare("SELECT status FROM runs WHERE id = ?").bind(id).first()).status;
      const attemptStatus = async (id) => (await db.prepare("SELECT status FROM agent_attempts WHERE id = ?").bind(id).first()).status;
      assert.equal(await runStatus("run_m_cancel_edge"), "canceled");
      // Valid leases (until +5 min) are untouched however long the silence.
      assert.equal(await runStatus("run_m_cancel_leased"), "cancel_requested");
      assert.equal(await runStatus("run_m_leased"), "reconciling");
      assert.equal(await attemptStatus("att_m_valid"), "running");
      // The 10-minute-old attempt cancel request is still within its 30 minutes.
      assert.equal(await attemptStatus("att_m_cancel_new"), "cancel_requested");
      // Once those leases lapse, the same rules apply.
      await scheduled(21 * MIN);
      assert.equal(await runStatus("run_m_cancel_leased"), "canceled");
      assert.equal(await runStatus("run_m_leased"), "reconciling", "stale in-flight runs are only reported");
      assert.equal(await attemptStatus("att_m_valid"), "failed");
      assert.equal(await attemptStatus("att_m_cancel_new"), "canceled");
      // A run heard from one hour ago: 23 h quiet is below 24 h; at +61 min it needs attention, but stays running.
      await scheduled(61 * MIN);
      assert.equal(await runStatus("run_m_quiet"), "running");
    });

    await t.test("finalizeStaleRuns (superadmin only) fails stale runs with an audit event", async () => {
      const { report } = await json(await maintenance({ action: "run", finalizeStaleRuns: true }, { actor: "root" }));
      assert.equal(report.runs.finalizeAllowed, true);
      assert.deepEqual(report.runs.staleFinalized.ids, ["run_m_stale"]);
      const run = await db.prepare("SELECT status, failure_reason FROM runs WHERE id = 'run_m_stale'").first();
      assert.deepEqual(run, { status: "failed", failure_reason: "执行器超过 24 小时未联系，平台按失败收尾（未确认调度器作业状态）" });
      const event = await db.prepare("SELECT from_status, to_status, actor_type, payload_json FROM run_events WHERE run_id = 'run_m_stale'").first();
      assert.deepEqual([event.from_status, event.to_status, event.actor_type, JSON.parse(event.payload_json).action], ["running", "failed", "system", "maintenance_stale_failed"]);
      assert.equal((await db.prepare("SELECT status FROM runs WHERE id = 'run_m_quiet'").first()).status, "running", "23 h quiet is not stale");
    });

    await t.test("a compute runner token may trigger a run: counts only, throttled", async () => {
      const { report } = await json(await maintenance({ action: "run" }, { bearer: tokens.compute }));
      assert.equal(report.dryRun, false);
      assert.deepEqual(report.runs.staleAttention, { count: 0, ids: [] });
      assert.equal(report.changeRequests.checked.count > 0, true);
      assert.deepEqual(report.changeRequests.checked.ids, [], "ids are withheld from lab callers");
      assert.equal((await json(await maintenance({ action: "run" }, { bearer: tokens.compute }), 429)).code, "TOO_SOON");
    });
  } finally {
    await mf.dispose();
  }
});

test("loop maintenance without GitHub App or Feishu: those steps are skipped", { timeout: 120_000 }, async () => {
  const NOW = Date.now();
  const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
  const outbound = [];
  const mf = new Miniflare({
    ...(await workerModules()),
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "loop-maintenance-unconfigured" },
    r2Buckets: ["FILES"],
    outboundService: async (request) => {
      outbound.push(`${request.method} ${request.url}`);
      return new Response("No external services in this test", { status: 502 });
    },
  });
  try {
    const db = await applyD1Migrations(mf);
    await seedBase(db, "bare");
    await insertChangeRequest(db, "cr_b_open", { pr_number: 21, updated_at: at(-60 * MIN) });
    await insertChangeRequest(db, "cr_b_publishing", { status: "publishing", head_commit_sha: null, updated_at: at(-20 * MIN) });
    await insertRun(db, "run_b_done", { status: "completed" });
    await insertNotification(db, "run_result_ready:run_b_done", { created_at: at(-10 * MIN) });
    const before = await snapshot(db);
    const response = await mf.dispatchFetch(`${ORIGIN}/api/admin/maintenance`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: "tanyan_session=bare-root; tanyan_persona=management" },
      body: JSON.stringify({ action: "run" }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const { report } = JSON.parse(text);
    assert.equal(report.changeRequests.skipped, "github_not_configured");
    assert.deepEqual(report.changeRequests.checked, { count: 0, ids: [] });
    assert.deepEqual(report.changeRequests.publishingStuck.ids, ["cr_b_publishing"], "stuck publishes are still reported");
    assert.equal(report.notifications.skipped, "feishu_not_configured");
    assert.deepEqual(report.notifications.candidates, { count: 0, ids: [] });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual(outbound, []);
  } finally {
    await mf.dispose();
  }
});
