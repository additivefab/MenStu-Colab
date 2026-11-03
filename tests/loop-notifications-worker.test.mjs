import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { issueRunnerToken } from "../lib/lab-runner-auth.ts";
import { digest } from "../lib/local-password.ts";
import { applyD1Migrations } from "./database-fixture.mjs";

// FB3 research-loop notifications (docs/科研闭环_实施规格_v1.md §12) against the
// built Worker. Everything is synthetic: Feishu and GitHub are doubles behind
// Miniflare's outboundService (fixture credentials only), and the agent worker
// and compute runner are simulated by direct protocol calls.

const FEISHU = { FEISHU_APP_ID: "cli_0000000000000001", FEISHU_APP_SECRET: "test-only-loop-notification-secret" };
const FEISHU_TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_MESSAGE_URL = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id";
const ORIGIN = "http://localhost";
const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "1".repeat(40);
const EVAL = "e".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const HEX_40 = /[0-9a-f]{40}/i;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// Links are built on the request's Host; Miniflare's Host is its local listener.
const deepLink = (url) => {
  const parsed = new URL(url);
  assert.match(parsed.origin, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  return parsed.pathname + parsed.hash;
};
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Users of the main scenario. Only `ou_…` ids are real Feishu identities.
const U = {
  a: { id: 901, openId: "ou_loop_student_a01", name: "合成学生甲", role: "student", studentId: "nt-a" },
  mentor1: { id: 902, openId: "ou_loop_mentor_0001", name: "合成导师一", role: "mentor" },
  mentor2: { id: 903, openId: "ou_loop_mentor_0002", name: "合成导师二", role: "mentor" },
  mentorLocal: { id: 904, openId: "local:nt-mentor-local", name: "本地导师", role: "mentor" },
  viewer: { id: 905, openId: "ou_loop_viewer_0001", name: "只读导师", role: "mentor" },
  root: { id: 906, openId: "ou_loop_root_000001", name: "超级管理员", role: "superadmin" },
  peer: { id: 907, openId: "ou_loop_peer_000001", name: "同伴学生", role: "student", studentId: "nt-p" },
  pending: { id: 908, openId: "ou_loop_pending_0001", name: "待审核", role: "pending" },
  inactive: { id: 909, openId: "ou_loop_inactive_001", name: "已停用导师", role: "mentor", active: 0 },
  b: { id: 910, openId: "ou_loop_student_b01", name: "合成学生乙", role: "student", studentId: "nt-b" },
};
const openIdOf = Object.fromEntries(Object.entries(U).map(([key, user]) => [user.openId, key]));
const persona = (actor) => (U[actor].role === "student" ? "student" : "management");

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

/** Feishu double: tenant token + message send, with a switchable failure mode. */
function feishuDouble() {
  const state = { mode: "ok", messages: [], tokenCalls: 0, pending: [] };
  async function handle(request) {
    if (request.url === FEISHU_TOKEN_URL) {
      state.tokenCalls += 1;
      const body = await request.json();
      assert.equal(body.app_id, FEISHU.FEISHU_APP_ID);
      return reply(200, { code: 0, tenant_access_token: "t-loop-fixture-token" });
    }
    if (request.url === FEISHU_MESSAGE_URL) {
      assert.equal(request.headers.get("authorization"), "Bearer t-loop-fixture-token");
      const raw = await request.text();
      const body = JSON.parse(raw);
      const card = JSON.parse(body.content);
      state.messages.push({
        raw, to: openIdOf[body.receive_id] ?? body.receive_id, uuid: body.uuid, msgType: body.msg_type,
        line: card.elements[0].text.content, url: card.elements[1]?.actions?.[0]?.url ?? null,
      });
      if (state.mode === "error") return reply(400, { code: 230013, msg: "Bot has NO availability to this user." });
      if (state.mode === "hang") {
        const wait = new Promise((resolve) => setTimeout(resolve, 6_000));
        state.pending.push(wait);
        await wait;
      }
      return reply(200, { code: 0, data: { message_id: `om_${state.messages.length}` } });
    }
    return null;
  }
  return {
    state,
    handle,
    /** Messages since the last drain, sorted by recipient key. */
    drain() {
      const taken = state.messages.splice(0);
      for (const message of taken) assert.ok(!HEX_40.test(message.raw), `no hash-like strings in Feishu payloads: ${message.raw}`);
      return taken.sort((left, right) => (left.to < right.to ? -1 : left.to > right.to ? 1 : 0));
    },
  };
}

test("loop notifications: recipients per event, idempotency, failures and payload hygiene", { timeout: 300_000 }, async (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const feishu = feishuDouble();
  const unexpected = [];
  const mf = new Miniflare({
    ...(await workerModules()),
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "loop-notifications-fixture" },
    r2Buckets: ["FILES"],
    bindings: { ...FEISHU, GITHUB_APP_ID: "424242", GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }) },
    outboundService: async (request) => {
      const handled = await feishu.handle(request);
      if (handled) return handled;
      const url = new URL(request.url);
      if (url.origin === "https://api.github.com") {
        if (request.method === "POST" && url.pathname === "/app/installations/9301/access_tokens") {
          return reply(201, { token: "ghs_loop_fixture", expires_at: "2026-11-03T13:00:00Z", repositories: [{ id: 5301, full_name: "loop-lab/nt-a" }] });
        }
        if (request.method === "GET" && url.pathname === "/repos/loop-lab/nt-a/git/ref/heads/main") {
          return reply(200, { ref: "refs/heads/main", object: { type: "commit", sha: BASE_SHA } });
        }
      }
      unexpected.push(`${request.method} ${request.url}`);
      return new Response("No other external services in this test", { status: 502 });
    },
  });

  const cookie = (actor) => `tanyan_session=loop-${actor}; tanyan_persona=${persona(actor)}`;
  const post = (path, body, actor) => mf.dispatchFetch(`${ORIGIN}${path}`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: cookie(actor) }, body: JSON.stringify(body),
  });
  const expectJson = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    return text ? JSON.parse(text) : null;
  };
  const tokens = {};
  const lab = (path, token, body) => mf.dispatchFetch(`${ORIGIN}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }).then((response) => expectJson(response));
  const agentLab = (body) => lab("/api/lab/agent-attempts", tokens.agent, body);
  const computeLab = (body) => lab("/api/lab/runs", tokens.compute, body);
  const tasks = (body, actor) => post("/api/research-tasks", body, actor).then((response) => expectJson(response));
  const attempts = (body, actor) => post("/api/agent-attempts", body, actor).then((response) => expectJson(response));
  const runs = (body, actor) => post("/api/runs", body, actor).then((response) => expectJson(response));

  /** Recipients (user keys) and lines of the messages sent since the last check. */
  const sent = () => feishu.drain();
  const recipientsOf = (messages) => messages.map((message) => message.to);

  try {
    const db = await applyD1Migrations(mf);
    const rows = async (eventKey) => (await db.prepare(`SELECT recipient_user_id, channel, status, attempts, last_error, sent_at
      FROM loop_notifications WHERE event_key = ? ORDER BY recipient_user_id`).bind(eventKey).all()).results;
    const userKey = (id) => Object.keys(U).find((key) => U[key].id === id);

    await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
      ('nt-a', '合成学生甲', '博士', 2025, '实验', 1), ('nt-p', '同伴学生', '博士', 2022, '论文', 1),
      ('nt-b', '合成学生乙', '硕士', 2025, '实验', 1)`).run();
    for (const [key, user] of Object.entries(U)) {
      await db.prepare("INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id, active) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(user.id, user.openId, user.name, user.role, user.studentId ?? null, user.active ?? 1).run();
      await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
        .bind(digest(`loop-${key}`), user.id).run();
    }
    // Reviewing mentors of nt-a: mentor1, mentor2, the local-only mentor and an
    // inactive one; the viewer may only view. The superadmin is not assigned.
    await db.prepare(`INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES
      (902, 'nt-a', 1, 1), (903, 'nt-a', 1, 1), (904, 'nt-a', 1, 1), (909, 'nt-a', 1, 1), (905, 'nt-a', 0, 1),
      (902, 'nt-b', 1, 1)`).run();
    await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (9301, 'loop-lab', 'Organization')").run();
    await db.prepare(`INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch)
      VALUES ('nt-a', 5301, 9301, 'loop-lab/nt-a', 'main')`).run();
    const agentToken = await issueRunnerToken();
    tokens.agent = agentToken.token;
    await db.prepare("INSERT INTO lab_runners(id, label, kind, token_sha256) VALUES ('rnr_loop_agent', '代理', 'agent', ?)").bind(agentToken.tokenSha256).run();
    await db.prepare(`INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES
      ('cred_loop_a', 901, 'codex', 'rnr_loop_agent'), ('cred_loop_m1', 902, 'codex', 'rnr_loop_agent')`).run();
    // A pending account can never be a valid delegate, even with a stray row.
    await db.prepare(`INSERT INTO review_delegations(id, student_id, reviewer_user_id, delegated_by_user_id, active)
      VALUES ('rdg_loop_pending', 'nt-a', 908, 902, 1)`).run();

    const content = (title, extra = {}) => ({
      title, researchQuestion: "数据增强是否提升泛化？", hypothesis: "随机裁剪更稳健", instructions: "只修改 src 下的数据管道",
      acceptanceCriteria: "单元测试通过", allowedPaths: ["src/**", "evaluation/**"], protectedPaths: ["evaluation/**"],
      budget: { maxAgentMinutes: 20, maxGpuCount: 2, maxWalltimeMinutes: 600 }, ...extra,
    });

    let taskId;
    await t.test("draft task: a mentor's draft notifies the student only; a student's own draft and confirmation notify nobody", async () => {
      const body = { action: "create", studentId: "nt-a", mutationId: "loop-task-mentor", ...content("数据增强实验") };
      const created = await tasks(body, "mentor1");
      taskId = created.task.id;
      const messages = sent();
      assert.deepEqual(recipientsOf(messages), ["a"]);
      assert.equal(messages[0].line, "需要你确认：合成学生甲 · 任务《数据增强实验》（第 1 版草稿）");
      assert.equal(deepLink(messages[0].url), `/students/nt-a#research-task-${taskId}`);
      assert.equal(messages[0].msgType, "interactive");
      assert.match(messages[0].uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const stored = await rows(`task_draft:${taskId}:v1`);
      assert.deepEqual(stored.map((row) => [userKey(row.recipient_user_id), row.channel, row.status, row.attempts, row.last_error]),
        [["a", "feishu", "sent", 1, ""]]);
      assert.ok(stored[0].sent_at);

      // Idempotent replay of the same create: no second message, no second row.
      assert.equal((await tasks(body, "mentor1")).replayed, true);
      assert.deepEqual(sent(), []);
      assert.equal((await rows(`task_draft:${taskId}:v1`)).length, 1);

      await tasks({ action: "confirm", taskId, version: 1 }, "a");
      const own = await tasks({ action: "create", studentId: "nt-a", mutationId: "loop-task-own", ...content("学生自建任务") }, "a");
      await tasks({ action: "confirm", taskId: own.task.id, version: 1 }, "mentor1");
      assert.deepEqual(sent(), [], "the actor is never notified and confirmation notifies nobody");
      assert.equal((await db.prepare("SELECT count(*) AS n FROM loop_notifications").first()).n, 1);
    });

    let changeRequestId;
    await t.test("plan submitted: the student and reviewing mentors, except the requester", async (st) => {
      const started = await attempts({ action: "start", taskId, provider: "codex", idempotencyKey: "loop-start-plan-a", planFirst: true }, "a");
      const attemptId = started.attempt.id;
      const work = (await agentLab({ action: "claim" })).work;
      assert.equal(work.mode, "plan");
      const planBody = { action: "result", attemptId, leaseEpoch: 1, outcome: "plan_ready", plan: "1. 在 src/data.py 中加入随机裁剪", files: [], unifiedDiff: "",
        modelId: "gpt-5-codex", sdkVersion: "0.0.0-test", tests: [], usage: {} };
      await agentLab(planBody);
      const messages = sent();
      assert.deepEqual(recipientsOf(messages), ["mentor1", "mentor2"], "requester, local-only, view-only, inactive and unassigned users are skipped");
      for (const message of messages) {
        assert.equal(message.line, "需要你审阅代理计划：合成学生甲 · 任务《数据增强实验》");
        assert.equal(deepLink(message.url), `/students/nt-a#research-task-${taskId}`);
      }
      // Same-epoch retry of the result is a replay: nothing new is sent.
      assert.equal((await agentLab(planBody)).replayed, true);
      assert.deepEqual(sent(), []);

      // A delegate exists from now on (granted through the API).
      await expectJson(await post("/api/review-delegations", { action: "grant", studentId: "nt-a", reviewerUserId: 907 }, "mentor1"));
      await attempts({ action: "decide_plan", attemptId, decision: "approved", note: "", expectedVersion: 2 }, "mentor1");
      assert.deepEqual(sent(), [], "a plan decision itself notifies nobody");

      await st.test("change request ready (normal): the student and active delegates", async () => {
        const edit = (await agentLab({ action: "claim" })).work;
        assert.equal(edit.mode, "edit");
        const text = "crop = True\n";
        const done = await agentLab({
          action: "result", attemptId, leaseEpoch: 2, outcome: "change_ready", modelId: "gpt-5-codex", sdkVersion: "0.0.0-test",
          files: [{ path: "src/data.py", action: "modify", contentBase64: Buffer.from(text).toString("base64"), sha256: sha256(text) }],
          unifiedDiff: "diff --git a/src/data.py b/src/data.py\n", tests: [], usage: {},
        });
        changeRequestId = done.changeRequest.id;
        assert.equal(done.changeRequest.requiresExtraReview, false);
        const ready = sent();
        assert.deepEqual(recipientsOf(ready), ["a", "peer"], "the pending account's stray delegation is ignored");
        assert.equal(ready[0].line, "需要你审查并发布代码修改：合成学生甲 · 任务《数据增强实验》");
        assert.deepEqual((await rows(`change_ready:${changeRequestId}`)).map((row) => [userKey(row.recipient_user_id), row.status]),
          [["a", "sent"], ["peer", "sent"]]);
      });

      const mentorAttempt = (await attempts({ action: "start", taskId, provider: "codex", idempotencyKey: "loop-start-plan-m1", planFirst: true }, "mentor1")).attempt.id;
      await agentLab({ action: "claim" });
      await agentLab({ ...planBody, attemptId: mentorAttempt });
      assert.deepEqual(recipientsOf(sent()), ["a", "mentor2"], "a mentor's plan goes to the student and the other mentors");
      await attempts({ action: "decide_plan", attemptId: mentorAttempt, decision: "rejected", note: "", expectedVersion: 2 }, "a");
      assert.deepEqual(sent(), []);
    });

    await t.test("change request with protected paths: reviewing mentors; after extra review approval: the student", async () => {
      const started = await attempts({ action: "start", taskId, provider: "codex", idempotencyKey: "loop-start-guarded" }, "a");
      const attemptId = started.attempt.id;
      const work = (await agentLab({ action: "claim" })).work;
      const text = "score = 1\n";
      const done = await agentLab({
        action: "result", attemptId, leaseEpoch: work.leaseEpoch, outcome: "change_ready", modelId: "gpt-5-codex", sdkVersion: "0.0.0-test",
        files: [{ path: "evaluation/score.py", action: "modify", contentBase64: Buffer.from(text).toString("base64"), sha256: sha256(text) }],
        unifiedDiff: "diff --git a/evaluation/score.py b/evaluation/score.py\n", tests: [], usage: {},
      });
      const guardedId = done.changeRequest.id;
      assert.equal(done.changeRequest.requiresExtraReview, true);
      const extra = sent();
      assert.deepEqual(recipientsOf(extra), ["mentor1", "mentor2"], "delegates and the requesting student do not do extra review");
      assert.equal(extra[0].line, "需要你额外审查：合成学生甲 · 任务《数据增强实验》的代码修改涉及受保护路径");
      assert.ok(!extra.some((message) => message.raw.includes("evaluation/score.py")), "no file names");

      const version = (await db.prepare("SELECT version FROM change_requests WHERE id = ?").bind(guardedId).first()).version;
      await expectJson(await post("/api/change-requests", { action: "approve_extra_review", changeRequestId: guardedId, expectedVersion: version }, "mentor1"));
      const ready = sent();
      assert.deepEqual(recipientsOf(ready), ["a"], "the approving mentor and the delegate (protected change) are not notified");
      assert.equal(ready[0].line, "需要你审查并发布代码修改：合成学生甲 · 任务《数据增强实验》");
    });

    let firstRun;
    await t.test("run awaiting approval: reviewing mentors except the run creator", async () => {
      // Publish the first change request (normally done through GitHub).
      await db.prepare("UPDATE change_requests SET status = 'open', head_commit_sha = ? WHERE id = ?").bind(HEAD_SHA, changeRequestId).run();
      const admin = (body) => post("/api/admin/lab", body, "root").then((response) => expectJson(response));
      const runner = await admin({ action: "register_runner", label: "GPU 服务器", kind: "compute" });
      tokens.compute = runner.token;
      tokens.computeId = runner.runner.id;
      const entrypoint = (await admin({ action: "register_entrypoint", studentId: "nt-a", name: "train", argv: ["python", "train.py"],
        imageRef: `registry.lab/train@${IMAGE_DIGEST}`, evaluationProtocolSha256: EVAL, paramsSchema: { lr: { type: "number", required: true, minimum: 0, maximum: 1 } } })).entrypoint;
      const dataset = (await admin({ action: "register_dataset", label: "合成数据 v1", runnerId: runner.runner.id, manifestSha256: "a".repeat(64),
        splitManifestSha256: "d".repeat(64), egressPolicy: { schema: "tanyan.egress/v1", allowedExtensions: [".json"], maxFileBytes: 1000,
          maxTotalBytes: 5000, allowImages: false, blockDatasetHashMatches: true } })).dataset;
      await admin({ action: "grant_dataset", datasetVersionId: dataset.id, studentId: "nt-a" });
      assert.deepEqual(sent(), []);

      const createBody = (key, lr) => ({ action: "create", taskId, changeRequestId, entrypointId: entrypoint.id, params: { lr },
        datasetVersionId: dataset.id, resources: { gpuCount: 1, walltimeMinutes: 60, memoryGb: 16 }, idempotencyKey: key });
      firstRun = await runs(createBody("loop-run-by-student", 0.1), "a");
      const byStudent = sent();
      assert.deepEqual(recipientsOf(byStudent), ["mentor1", "mentor2"]);
      assert.equal(byStudent[0].line, "需要你批准：合成学生甲 · 任务《数据增强实验》运行 #1");
      assert.equal(deepLink(byStudent[0].url), `/students/nt-a#research-run-${firstRun.runId}`);
      assert.equal((await runs(createBody("loop-run-by-student", 0.1), "a")).replayed, true);
      assert.deepEqual(sent(), [], "idempotent create replay");

      const byMentor = await runs(createBody("loop-run-by-mentor", 0.2), "mentor1");
      const mentorMessages = sent();
      assert.deepEqual(recipientsOf(mentorMessages), ["mentor2"], "the creating mentor never approves their own run");
      assert.equal(mentorMessages[0].line, "需要你批准：合成学生甲 · 任务《数据增强实验》运行 #2");
      await runs({ action: "cancel", runId: byMentor.runId }, "mentor1");
      assert.deepEqual(sent(), []);
    });

    await t.test("result ready: the student and reviewing mentors; review saved: the student", async () => {
      await runs({ action: "approve", runId: firstRun.runId, runSpecSha256: firstRun.runSpecSha256 }, "mentor1");
      const work = (await computeLab({ action: "claim" })).work;
      assert.equal(work.runId, firstRun.runId);
      const metrics = JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: EVAL, split: "test", values: { accuracy: 0.91 } });
      const manifest = {
        schema: "tanyan.manifest/v1", runId: work.runId, attempt: work.attempt, runSpecSha256: work.runSpecSha256, approvalId: work.approvalId,
        repository: { repositoryId: work.spec.repository.repositoryId, executedCommitSha: work.spec.executedCommitSha },
        inputs: { datasetVersionId: work.spec.dataset.versionId, manifestSha256: work.spec.dataset.manifestSha256,
          splitManifestSha256: work.spec.dataset.splitManifestSha256, evaluationProtocolSha256: work.spec.evaluationProtocolSha256, seeds: [7] },
        environment: { imageDigest: IMAGE_DIGEST, driverVersion: "550.00", gpuModel: "synthetic" },
        execution: { runnerId: tokens.computeId, schedulerJobId: "4242", submitTag: work.submitTag, entrypointId: work.spec.entrypoint.id,
          startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T01:00:00Z", exitCode: 0 },
        metricsArtifactPath: "metrics.json",
        artifacts: [{ relativePath: "metrics.json", sha256: sha256(metrics), sizeBytes: Buffer.byteLength(metrics), kind: "metrics",
          egressDecision: "published", egressReason: "runner", labLocator: "lab://out/metrics.json" }],
      };
      const completeBody = { action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "completed", exitCode: 0, manifest,
        publishedFiles: [{ relativePath: "metrics.json", contentBase64: Buffer.from(metrics).toString("base64") }] };
      assert.equal((await computeLab(completeBody)).status, "completed");
      const ready = sent();
      assert.deepEqual(recipientsOf(ready), ["a", "mentor1", "mentor2"]);
      for (const message of ready) {
        assert.equal(message.line, "运行已完成，结果待评审：合成学生甲 · 任务《数据增强实验》运行 #1");
        assert.ok(!message.raw.includes("0.91") && !message.raw.includes("metrics.json"), "no metric values or file names");
      }
      assert.deepEqual(await computeLab(completeBody), { status: "completed", replayed: true });
      assert.deepEqual(sent(), [], "a completion replay sends nothing");

      const reviewed = await post("/api/run-results", { action: "review", runId: firstRun.runId, state: "accepted", hypothesisOutcome: "supported",
        note: "学生私密备注：不要外传", expectedVersion: 1 }, "mentor1").then((response) => expectJson(response));
      const review = sent();
      assert.deepEqual(recipientsOf(review), ["a"]);
      assert.equal(review[0].line, "导师已评审运行结果：合成学生甲 · 任务《数据增强实验》运行 #1（结论：已验收）");
      assert.ok(!review[0].raw.includes("私密"), "review notes never leave the platform");
      assert.deepEqual((await rows(`review_saved:${firstRun.runId}:v${reviewed.version}`)).map((row) => [userKey(row.recipient_user_id), row.status]), [["a", "sent"]]);
    });

    await t.test("send failures are recorded and never break the main request", async () => {
      feishu.state.mode = "error";
      const created = await tasks({ action: "create", studentId: "nt-a", mutationId: "loop-task-failing", ...content("失败投递") }, "mentor1");
      assert.equal(created.replayed, false);
      assert.equal(sent().length, 1);
      const [failed] = await rows(`task_draft:${created.task.id}:v1`);
      assert.deepEqual([failed.status, failed.attempts, failed.sent_at], ["failed", 1, null]);
      assert.ok(failed.last_error.length > 0 && failed.last_error.length <= 200);

      feishu.state.mode = "hang";
      const started = Date.now();
      const slow = await tasks({ action: "create", studentId: "nt-a", mutationId: "loop-task-hanging", ...content("超时投递") }, "mentor1");
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 5_500, `a hanging Feishu call is cut off by the short timeout (${elapsed} ms)`);
      const [timedOut] = await rows(`task_draft:${slow.task.id}:v1`);
      assert.deepEqual([timedOut.status, timedOut.attempts], ["failed", 1]);
      assert.match(timedOut.last_error, /超时/);
      await Promise.all(feishu.state.pending);
      sent();
      feishu.state.mode = "ok";
    });

    assert.deepEqual(unexpected, [], "no other request left the Worker");
    const all = (await db.prepare("SELECT recipient_user_id FROM loop_notifications").all()).results.map((row) => userKey(row.recipient_user_id));
    for (const never of ["mentorLocal", "viewer", "root", "pending", "inactive", "b"]) assert.ok(!all.includes(never), `${never} is never a recipient`);
  } finally {
    await mf.dispose();
  }
});

test("loop notifications are recorded as skipped when Feishu is not configured", { timeout: 120_000 }, async () => {
  let outbound = 0;
  const mf = new Miniflare({
    ...(await workerModules()),
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "loop-notifications-unconfigured" },
    r2Buckets: ["FILES"],
    outboundService: () => { outbound += 1; return new Response("External requests are disabled in this test", { status: 502 }); },
  });
  try {
    const db = await applyD1Migrations(mf);
    await db.prepare("INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES ('nt-s', '合成学生丙', '博士', 2025, '实验', 1)").run();
    await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
      (951, 'ou_loop_skip_student1', '合成学生丙', 'student', 'nt-s'), (952, 'ou_loop_skip_mentor01', '合成导师', 'mentor', NULL)`).run();
    await db.prepare("INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES (952, 'nt-s', 1, 1)").run();
    await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, 952, datetime('now', '+1 day'))").bind(digest("loop-skip-mentor")).run();
    const response = await mf.dispatchFetch(`${ORIGIN}/api/research-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: "tanyan_session=loop-skip-mentor; tanyan_persona=management" },
      body: JSON.stringify({ action: "create", studentId: "nt-s", mutationId: "loop-skip-task", title: "未配置飞书", researchQuestion: "问题",
        hypothesis: "假设", instructions: "说明", acceptanceCriteria: "标准", allowedPaths: ["src/**"], budget: { maxAgentMinutes: 10 } }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const taskId = JSON.parse(text).task.id;
    const stored = (await db.prepare("SELECT recipient_user_id, status, attempts, last_error FROM loop_notifications WHERE event_key = ?")
      .bind(`task_draft:${taskId}:v1`).all()).results;
    assert.deepEqual(stored, [{ recipient_user_id: 951, status: "skipped", attempts: 0, last_error: "" }]);
    assert.equal(outbound, 0, "nothing is sent without Feishu credentials");
  } finally {
    await mf.dispose();
  }
});
