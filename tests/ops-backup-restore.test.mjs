import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { digest } from "../lib/local-password.ts";
import {
  RestoreRefusedError, createBackup, emitSql, listUserTables, loadSqlDump, restoreBackup, splitSqlStatements, verifyRestore,
} from "../scripts/ops/backup-core.mjs";
import { applyD1Migrations } from "./database-fixture.mjs";

// T26 backup/restore DRILL against the built Worker. Every fixture is
// synthetic, outbound network is blocked, GitHub is unconfigured and the lab
// runner is simulated by direct protocol calls (as in runs-worker.test.mjs).
// What this proves: D1 + R2 of a realistic research loop survive a backup and
// a restore into a FRESH instance with relations and artifacts intact, and the
// restored platform rejects every pre-restore session cookie and runner token.
// Not covered: hosted D1/R2 (wrangler --remote, rclone) — see docs/ops/备份与恢复.md.
const EVAL = "e".repeat(64);
const IMAGE = `registry.lab/train@sha256:${"c".repeat(64)}`;
const SHA_HEAD = "1".repeat(40);
const BASE = "0".repeat(40);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const origin = "http://localhost";
const personas = { studentA: "student", studentB: "student" };

async function workerModules() {
  const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".js"));
  return { modules: ["index.js", ...files.filter((file) => file !== "index.js")].map((path) => ({ type: "ESModule", path: root + path })), modulesRoot: root };
}

async function startWorker(name, state) {
  return new Miniflare({
    ...await workerModules(), compatibilityDate: "2026-05-22", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: name }, r2Buckets: ["FILES"],
    outboundService: () => { state.outbound += 1; return new Response("No external services in this test", { status: 502 }); },
  });
}

function bareStorage(name) {
  return new Miniflare({
    modules: true, script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
    compatibilityDate: "2025-09-01", d1Databases: { DB: name }, r2Buckets: ["FILES"],
  });
}

function client(mf) {
  const cookie = (actor) => (actor ? `tanyan_session=ops-${actor}; tanyan_persona=${personas[actor] ?? "management"}` : "");
  const call = (path, { actor, method = "GET", body, headers = {} } = {}) => mf.dispatchFetch(origin + path, {
    method, headers: { cookie: cookie(actor), ...(body ? { "content-type": "application/json", origin } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = async (response, expected = 200) => {
    const text = await response.text();
    assert.equal(response.status, expected, text);
    return text ? JSON.parse(text) : null;
  };
  const lab = (token, body) => mf.dispatchFetch(origin + "/api/lab/runs", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return {
    call, json, lab,
    get: (path, actor, status = 200) => call(path, { actor }).then((response) => json(response, status)),
    post: (path, body, actor, status = 200) => call(path, { actor, method: "POST", body }).then((response) => json(response, status)),
  };
}

/** Seeds a full loop: task → attempt (change.json in R2) → change request → approved run with
 * R2 artifacts → result → accepted review → follow-up task (lineage), plus an in-flight run,
 * a progress attachment, local credentials and an unreferenced R2 object. */
async function seedLoop(mf, db, bucket) {
  const api = client(mf);
  await db.prepare(`INSERT INTO students(id, display_name, degree, grade_year, stage, active) VALUES
    ('ops-a', '演练学生甲', '博士', 2025, '实验', 1), ('ops-b', '演练学生乙', '硕士', 2025, '实验', 1)`).run();
  await db.prepare(`INSERT INTO app_users(id, feishu_open_id, display_name, role, student_id) VALUES
    (1101, 'ops-student-a', '演练学生甲', 'student', 'ops-a'), (1102, 'ops-student-b', '演练学生乙', 'student', 'ops-b'),
    (1103, 'ops-mentor-1', '演练导师', 'mentor', NULL), (1106, 'ops-root', '超级管理员', 'superadmin', NULL)`).run();
  await db.prepare("INSERT INTO mentor_student_assignments(mentor_user_id, student_id, can_review, active) VALUES (1103, 'ops-a', 1, 1)").run();
  for (const [id, actor] of [[1101, "studentA"], [1102, "studentB"], [1103, "mentor1"], [1106, "root"]]) {
    await db.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").bind(digest(`ops-${actor}`), id).run();
  }
  // Local login: an active password (kept on restore) and a pending activation (cleared on restore).
  await db.prepare(`INSERT INTO local_credentials(app_user_id, student_id, authorized_role, username, password_hash) VALUES
    (1101, 'ops-a', 'student', 'ops-student-a', ?)`).bind(`scrypt:16384:8:5:${"a".repeat(32)}:${"b".repeat(64)}`).run();
  await db.prepare(`INSERT INTO local_credentials(app_user_id, student_id, authorized_role, username, activation_hash, activation_expires_at) VALUES
    (1102, 'ops-b', 'student', 'ops-student-b', ?, datetime('now', '+1 day'))`).bind(sha256("synthetic-activation-code")).run();
  await db.prepare("INSERT INTO local_auth_attempts(key, attempts, window_start) VALUES ('login:ops-student-a', 2, 1)").run();

  await db.prepare("INSERT INTO github_installations(installation_id, account_login, account_type) VALUES (77, 'synthetic-lab', 'Organization')").run();
  await db.prepare("INSERT INTO repository_links(student_id, github_repository_id, installation_id, full_name, default_branch) VALUES ('ops-a', 5001, 77, 'synthetic-lab/a-research', 'main')").run();
  await db.prepare(`INSERT INTO research_tasks(id, student_id, title, status, current_version, confirmed_version, created_by_user_id, create_mutation_id, last_mutation_id)
    VALUES ('task_ops', 'ops-a', '演练任务', 'confirmed', 1, 1, 1101, 'seed-task_ops', 'seed-task_ops')`).run();
  await db.prepare(`INSERT INTO research_task_versions(task_id, version, title, research_question, instructions, acceptance_criteria,
    budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at)
    VALUES ('task_ops', 1, '演练任务', '演练问题', '演练说明', '演练标准', '{"maxGpuCount":2,"maxWalltimeMinutes":600}', ?, 1101, 1101, CURRENT_TIMESTAMP)`)
    .bind("d".repeat(64)).run();
  await db.prepare(`INSERT INTO research_task_events(task_id, version, action, actor_type, actor_user_id) VALUES
    ('task_ops', 1, 'created', 'user', 1101), ('task_ops', 1, 'confirmed', 'user', 1101)`).run();

  const agentRunner = await api.post("/api/admin/lab", { action: "register_runner", label: "代理工作进程", kind: "agent" }, "root");
  const computeRunner = await api.post("/api/admin/lab", { action: "register_runner", label: "GPU 服务器", kind: "compute" }, "root");
  await db.prepare("INSERT INTO agent_credential_profiles(id, user_id, provider, worker_id) VALUES ('cred_ops', 1101, 'codex', ?)").bind(agentRunner.runner.id).run();
  // The agent's change file, as lib/agent-attempts-service.ts stores it.
  const changeJson = JSON.stringify({ files: [{ action: "modify", path: "src/model.py", contentBase64: Buffer.from("print('v2')\n").toString("base64") }], unifiedDiff: "--- a\n+++ b\n" });
  const changeSha = sha256(changeJson);
  await bucket.put("agent-attempts/att_ops/change.json", changeJson, { httpMetadata: { contentType: "application/json" }, customMetadata: { attemptId: "att_ops", sha256: changeSha } });
  await db.prepare(`INSERT INTO agent_attempts(id, task_id, task_version, student_id, provider, credential_profile_id, github_repository_id,
    base_commit_sha, context_snapshot_sha256, status, idempotency_key, requested_by_user_id, diff_sha256, diff_r2_key, worker_id)
    VALUES ('att_ops', 'task_ops', 1, 'ops-a', 'codex', 'cred_ops', 5001, ?, ?, 'change_ready', 'seed-attempt', 1101, ?, 'agent-attempts/att_ops/change.json', ?)`)
    .bind(BASE, "d".repeat(64), changeSha, agentRunner.runner.id).run();
  await db.prepare(`INSERT INTO agent_attempt_events(attempt_id, sequence, kind, payload_json) VALUES
    ('att_ops', -1, 'status', '{"source":"platform","to":"running"}'), ('att_ops', 1, 'message', '{"text":"edited"}')`).run();
  await db.prepare(`INSERT INTO change_requests(id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, status, pr_number, pr_url)
    VALUES ('cr_ops', 'task_ops', 'att_ops', 'ops-a', 5001, ?, 'tanyan/ops/att', ?, 'open', 8, 'https://github.com/synthetic-lab/a-research/pull/8')`)
    .bind(BASE, SHA_HEAD).run();

  const entrypoint = (await api.post("/api/admin/lab", {
    action: "register_entrypoint", studentId: "ops-a", name: "train", argv: ["python", "train.py"], imageRef: IMAGE, evaluationProtocolSha256: EVAL,
    paramsSchema: { lr: { type: "number", required: true, minimum: 0, maximum: 1 } },
  }, "root")).entrypoint;
  const dataset = (await api.post("/api/admin/lab", {
    action: "register_dataset", label: "合成数据 v1", runnerId: computeRunner.runner.id, manifestSha256: "a".repeat(64), splitManifestSha256: "b".repeat(64),
    // R03: held by default; opting tables/loss.csv in keeps a second R2 object to back up.
    egressPolicy: { schema: "tanyan.egress/v1", allowedExtensions: [".json", ".csv"], maxFileBytes: 10_000, maxTotalBytes: 50_000, allowImages: false, blockDatasetHashMatches: true, autoPublishPaths: ["tables/loss.csv"] },
  }, "root")).dataset;
  await api.post("/api/admin/lab", { action: "grant_dataset", datasetVersionId: dataset.id, studentId: "ops-a" }, "root");

  const create = (lr, key) => api.post("/api/runs", {
    action: "create", taskId: "task_ops", changeRequestId: "cr_ops", entrypointId: entrypoint.id, params: { lr },
    datasetVersionId: dataset.id, resources: { gpuCount: 1, walltimeMinutes: 60, memoryGb: 16 }, idempotencyKey: key,
  }, "studentA");
  const claim = async () => api.json(await api.lab(computeRunner.token, { action: "claim" }));

  // Completed run with metrics + a table in R2.
  const run = await create(0.1, "ops-create-000001");
  await api.post("/api/runs", { action: "approve", runId: run.runId, runSpecSha256: run.runSpecSha256 }, "mentor1");
  const { work } = await claim();
  assert.equal(work.runId, run.runId);
  await api.json(await api.lab(computeRunner.token, { action: "heartbeat", runId: work.runId, leaseEpoch: work.leaseEpoch, phase: "running", schedulerJobId: "4242" }));
  const metrics = JSON.stringify({ schema: "tanyan.metrics/v1", evaluationProtocolSha256: EVAL, split: "test", values: { accuracy: 0.91 } });
  const table = "epoch,loss\n1,0.5\n2,0.3\n";
  const files = [["metrics.json", metrics, "metrics"], ["tables/loss.csv", table, "table"]];
  const artifacts = files.map(([relativePath, content, kind]) => ({ relativePath, sha256: sha256(content), sizeBytes: Buffer.byteLength(content), kind, egressDecision: "published", egressReason: "runner", labLocator: `lab://out/${relativePath}` }));
  const done = await api.json(await api.lab(computeRunner.token, {
    action: "complete", runId: work.runId, leaseEpoch: work.leaseEpoch, outcome: "completed", exitCode: 0,
    manifest: {
      schema: "tanyan.manifest/v1", runId: work.runId, attempt: work.attempt, runSpecSha256: work.runSpecSha256, approvalId: work.approvalId,
      repository: { repositoryId: work.spec.repository.repositoryId, executedCommitSha: work.spec.executedCommitSha },
      inputs: { datasetVersionId: work.spec.dataset.versionId, manifestSha256: work.spec.dataset.manifestSha256, splitManifestSha256: work.spec.dataset.splitManifestSha256, evaluationProtocolSha256: work.spec.evaluationProtocolSha256, seeds: [7] },
      environment: { imageDigest: `sha256:${"c".repeat(64)}`, driverVersion: "550.00", gpuModel: "synthetic" },
      execution: { runnerId: computeRunner.runner.id, schedulerJobId: "4242", submitTag: work.submitTag, entrypointId: work.spec.entrypoint.id, startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T01:00:00Z", exitCode: 0 },
      metricsArtifactPath: "metrics.json", artifacts,
    },
    publishedFiles: files.map(([relativePath, content]) => ({ relativePath, contentBase64: Buffer.from(content).toString("base64") })),
  }));
  assert.equal(done.technicalValidity, "valid");
  await api.post("/api/run-results", { action: "review", runId: run.runId, expectedVersion: 1, state: "accepted", hypothesisOutcome: "supported", note: "演练复核通过" }, "mentor1");
  await api.post("/api/run-results", { action: "comment", runId: run.runId, requestId: "ops-comment-000001", body: "指标合理" }, "studentA");
  const follow = await api.post("/api/run-results", {
    action: "followup", runId: run.runId, mutationId: "ops-follow-000001", title: "后续：消融", researchQuestion: "去掉模块 X",
    instructions: "只改 src/model", acceptanceCriteria: "同协议指标", budget: { maxGpuCount: 1 },
  }, "mentor1");

  // A second run left in flight (leased) at backup time.
  const inflight = await create(0.2, "ops-create-000002");
  await api.post("/api/runs", { action: "approve", runId: inflight.runId, runSpecSha256: inflight.runSpecSha256 }, "mentor1");
  assert.equal((await claim()).work.runId, inflight.runId);

  // A progress attachment and an unreferenced (abandoned upload) object.
  const entry = await db.prepare("INSERT INTO progress_entries(student_id, kind, title, submitted_by_user_id) VALUES ('ops-a', 'experiment', '演练进展', 1101) RETURNING id").first();
  const attachment = "synthetic attachment body\n";
  const storageKey = `progress/ops-a/${entry.id}/00000000-0000-4000-8000-00000000a11c.txt`;
  await bucket.put(storageKey, attachment, { httpMetadata: { contentType: "text/plain" } });
  await db.prepare(`INSERT INTO progress_attachments(progress_entry_id, storage_key, file_name, content_type, size_bytes, content_sha256, uploaded_by_user_id)
    VALUES (?, ?, 'notes.txt', 'text/plain', ?, ?, 1101)`).bind(entry.id, storageKey, Buffer.byteLength(attachment), sha256(attachment)).run();
  await bucket.put("progress/ops-a/orphan/abandoned.txt", "abandoned upload\n");
  // A deleted row leaves an AUTOINCREMENT gap the restore must preserve.
  await db.prepare("INSERT INTO research_task_events(task_id, version, action, actor_type) VALUES ('task_ops', 1, 'revised', 'system')").run();
  await db.prepare("DELETE FROM research_task_events WHERE action = 'revised'").run();

  return { runId: run.runId, inflightRunId: inflight.runId, followupTaskId: follow.taskId, computeRunner, agentRunner, storageKey, attachment, table };
}

const failing = (verification) => JSON.stringify(verification.checks.filter((item) => item.status !== "pass"), null, 2);

test("T26 drill: backup a research loop, restore into a fresh instance, verify, and reject every old token", { timeout: 300_000 }, async (t) => {
  const work = mkdtempSync(join(tmpdir(), "ops-drill-"));
  const state = { outbound: 0 };
  const source = await startWorker("ops-source", state);
  const restored = await startWorker("ops-restored", state);
  t.after(async () => {
    await source.dispose();
    await restored.dispose();
    rmSync(work, { recursive: true, force: true });
  });

  const sourceDb = await applyD1Migrations(source);
  const sourceBucket = await source.getR2Bucket("FILES");
  const seeded = await seedLoop(source, sourceDb, sourceBucket);
  const src = client(source);
  const dst = client(restored);

  // Positive controls: on the source, the cookie and the runner token work.
  await src.get(`/api/runs?runId=${seeded.runId}`, "studentA");
  assert.deepEqual(await src.json(await src.lab(seeded.computeRunner.token, { action: "claim" })), { work: null });

  let backup;
  await t.test("backup writes a manifest with row counts, R2 hashes and schema version, and no plaintext secrets", async () => {
    backup = await createBackup({ db: sourceDb, bucket: sourceBucket, outDir: work, source: { kind: "drill" } });
    const { manifest } = backup;
    assert.match(backup.dir, /backup-\d{8}T\d{6}Z$/);
    assert.equal(manifest.schema.appSchemaVersion, 28);
    for (const table of await listUserTables(sourceDb)) {
      const n = Number((await sourceDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first()).n);
      assert.equal(manifest.d1.tables[table]?.rows, n, table);
    }
    assert.equal(manifest.d1.tables.runs.rows, 2);
    assert.equal(manifest.d1.tables.app_sessions.rows, 4);
    const keys = manifest.r2.objects.map((item) => item.key);
    assert.ok(keys.includes("agent-attempts/att_ops/change.json"));
    assert.ok(keys.includes(`runs/${seeded.runId}/metrics.json`) && keys.includes(`runs/${seeded.runId}/tables/loss.csv`));
    assert.ok(keys.includes(seeded.storageKey) && keys.includes("progress/ops-a/orphan/abandoned.txt"));
    assert.equal(manifest.r2.objects.find((item) => item.key === seeded.storageKey).sha256, sha256(seeded.attachment));
    assert.equal(manifest.r2.referencedByDatabase, 4);
    assert.equal(manifest.r2.unreferencedKeys, 1);
    assert.deepEqual(manifest.sourcePreflight, { missingObjects: [], mismatchedObjects: [] });
    assert.equal(manifest.secrets.exported, false);
    assert.deepEqual(manifest.secrets.secretScanFindings, []);
    // Only hashes are stored: the issued runner tokens and session cookies never appear in the backup.
    const everything = readdirSync(backup.dir, { recursive: true }).map((file) => { try { return readFileSync(join(backup.dir, file), "utf8"); } catch { return ""; } }).join("\n");
    for (const secret of [seeded.computeRunner.token, seeded.agentRunner.token, "ops-studentA", "synthetic-activation-code"]) {
      assert.ok(!everything.includes(secret), "plaintext token must not be in the backup");
    }
  });

  await t.test("a backup refuses rows that look like live credentials", async () => {
    const scratch = bareStorage("ops-secret-scan");
    try {
      const db = await scratch.getD1Database("DB");
      await db.prepare("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)").run();
      await db.prepare("INSERT INTO notes(body) VALUES (?)").bind(`token ghs_${"A1b2C3d4".repeat(5)}`).run();
      await assert.rejects(createBackup({ db, bucket: await scratch.getR2Bucket("FILES"), outDir: join(work, "scan") }), /look like live credentials/);
      assert.deepEqual(readdirSync(join(work, "scan")), [], "no partial backup left behind");
    } finally { await scratch.dispose(); }
  });

  let restoredDb, restoredBucket, result;
  await t.test("restore into a fresh instance passes FK, row-count, relation and R2 verification", async () => {
    restoredDb = await restored.getD1Database("DB");
    restoredBucket = await restored.getR2Bucket("FILES");
    assert.deepEqual(await listUserTables(restoredDb), [], "target starts empty");
    result = await restoreBackup({ db: restoredDb, bucket: restoredBucket, backupDir: backup.dir });
    assert.ok(result.verification.ok, failing(result.verification));
    const ids = result.verification.checks.map((item) => item.id);
    for (const id of ["foreign_keys", "row_counts", "schema_version", "r2_references", "r2_objects", "credentials_invalidated",
      "relation_change_request_attempt", "relation_run_spec", "relation_review_followup", "relation_content_hashes"]) assert.ok(ids.includes(id), id);
    assert.equal(result.verification.stats.completeChains, 1, "the completed run keeps task→attempt→CR→spec→run→result→review");
    assert.equal(result.verification.stats.referencedObjects, 4);
    assert.deepEqual(result.invalidation, { sessionsDeleted: 4, runnersDisabled: 2, activationsCleared: 1, authAttemptsCleared: 1, githubTokensCleared: 0, unexpectedTokenColumns: [] });
    // Lineage and AUTOINCREMENT counters are preserved exactly.
    const task = await restoredDb.prepare("SELECT source_run_id, parent_task_id FROM research_tasks WHERE id = ?").bind(seeded.followupTaskId).first();
    assert.deepEqual(task, { source_run_id: seeded.runId, parent_task_id: "task_ops" });
    const sequence = async (db) => (await db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'research_task_events'").first()).seq;
    assert.equal(await sequence(restoredDb), await sequence(sourceDb));
    assert.equal((await restoredDb.prepare("SELECT password_hash FROM local_credentials WHERE app_user_id = 1101").first()).password_hash.slice(0, 7), "scrypt:");
    const inflight = await restoredDb.prepare("SELECT status, lease_epoch FROM runs WHERE id = ?").bind(seeded.inflightRunId).first();
    assert.deepEqual(inflight, { status: "dispatching", lease_epoch: 1 }, "in-flight state is restored as-is for reconciliation");
  });

  await t.test("the restored platform rejects old session cookies and old runner tokens (T26)", async () => {
    for (const actor of ["studentA", "mentor1", "root"]) {
      await dst.get(`/api/runs?runId=${seeded.runId}`, actor, 401);
    }
    const artifact = await restoredDb.prepare("SELECT id FROM run_artifacts WHERE run_id = ? AND relative_path = 'tables/loss.csv'").bind(seeded.runId).first();
    await dst.get(`/api/run-artifacts?artifactId=${artifact.id}`, "studentA", 401);
    for (const token of [seeded.computeRunner.token, seeded.agentRunner.token]) {
      const refused = await dst.lab(token, { action: "claim" });
      assert.equal(refused.status, 401);
      assert.equal((await refused.json()).code, "RUNNER_AUTH_INVALID");
    }
    const runners = (await restoredDb.prepare("SELECT status FROM lab_runners").all()).results;
    assert.ok(runners.length === 2 && runners.every((row) => row.status === "disabled"));
  });

  await t.test("readiness reports a schema pass on the restored database", async () => {
    const ready = await (await restored.dispatchFetch(`${origin}/api/health/ready`)).json();
    const schema = ready.checks.find((item) => item.id === "schema");
    assert.equal(schema.status, "pass", JSON.stringify(ready));
    assert.match(schema.detail, /v28/);
  });

  await t.test("after re-login and token re-issue the restored data serves the same results and bytes", async () => {
    // Simulates a fresh sign-in (new session) and scripts/ops/reissue-runner-token.mjs (same runner id, new hash).
    await restoredDb.prepare("INSERT INTO app_sessions(token_hash, app_user_id, expires_at) VALUES (?, 1101, datetime('now', '+1 day'))").bind(digest("ops-studentA-new")).run();
    const cookie = { cookie: "tanyan_session=ops-studentA-new; tanyan_persona=student" };
    const detail = await dst.json(await restored.dispatchFetch(`${origin}/api/runs?runId=${seeded.runId}`, { headers: cookie }));
    assert.equal(detail.result.technicalValidity, "valid");
    assert.deepEqual(detail.result.metrics.values, { accuracy: 0.91 });
    assert.equal(detail.review.state, "accepted");
    assert.equal(detail.review.followupTaskId, seeded.followupTaskId);
    const csv = detail.artifacts.find((item) => item.relativePath === "tables/loss.csv");
    const download = await restored.dispatchFetch(`${origin}/api/run-artifacts?artifactId=${csv.id}`, { headers: cookie });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), seeded.table);

    const fresh = "N".repeat(43);
    await restoredDb.prepare("UPDATE lab_runners SET token_sha256 = ?, status = 'active' WHERE id = ?").bind(sha256(fresh), seeded.computeRunner.runner.id).run();
    assert.equal((await dst.lab(fresh, { action: "claim" })).status, 200);
    assert.equal((await dst.lab(seeded.computeRunner.token, { action: "claim" })).status, 401, "the old token stays invalid after re-issue");
    await restoredDb.prepare("DELETE FROM app_sessions").run();
    await restoredDb.prepare("UPDATE lab_runners SET token_sha256 = 'revoked-by-test', status = 'disabled' WHERE id = ?").bind(seeded.computeRunner.runner.id).run();
  });

  await t.test("emitted SQL for wrangler d1 execute rebuilds an identical database", async () => {
    const out = join(work, "emit");
    const { restoreFile, sequencesFile } = await emitSql(restoredDb, out);
    const replay = bareStorage("ops-sql-replay");
    try {
      const db = await replay.getD1Database("DB");
      const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const statement of lines(restoreFile)) await db.prepare(statement).run();
      for (const statement of lines(sequencesFile)) await db.prepare(statement).run();
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
      const replayCheck = await verifyRestore({ db, bucket: restoredBucket, manifest: backup.manifest, backupDir: backup.dir });
      assert.ok(replayCheck.ok, failing(replayCheck));
      const run = await db.prepare("SELECT canonical_json FROM run_specs s JOIN runs r ON r.run_spec_sha256 = s.sha256 WHERE r.id = ?").bind(seeded.runId).first();
      const original = await sourceDb.prepare("SELECT canonical_json FROM run_specs s JOIN runs r ON r.run_spec_sha256 = s.sha256 WHERE r.id = ?").bind(seeded.runId).first();
      assert.equal(run.canonical_json, original.canonical_json, "multi-line/quoted text survives the SQL round trip");
    } finally { await replay.dispose(); }
  });

  await t.test("refuses a non-empty target and a damaged backup", async () => {
    await assert.rejects(restoreBackup({ db: restoredDb, bucket: restoredBucket, backupDir: backup.dir }), RestoreRefusedError);
    const damaged = join(work, "damaged");
    cpSync(backup.dir, damaged, { recursive: true });
    const blob = backup.manifest.r2.objects.find((item) => item.key.endsWith("tables/loss.csv")).sha256;
    writeFileSync(join(damaged, "r2", "blobs", blob), "epoch,loss\n1,0.0\n");
    const target = bareStorage("ops-damaged-target");
    try {
      const db = await target.getD1Database("DB");
      await assert.rejects(restoreBackup({ db, bucket: await target.getR2Bucket("FILES"), backupDir: damaged }), /fail their manifest hashes/);
      assert.deepEqual(await listUserTables(db), [], "nothing loaded from a damaged backup");
    } finally { await target.dispose(); }
  });

  await t.test("verification is not vacuous: a lost artifact, a tampered spec and a broken lineage are reported", async () => {
    await restoredBucket.delete(`runs/${seeded.runId}/tables/loss.csv`);
    await restoredDb.prepare("UPDATE run_specs SET canonical_json = canonical_json || ' ' WHERE sha256 = (SELECT run_spec_sha256 FROM runs WHERE id = ?)").bind(seeded.runId).run();
    await restoredDb.prepare("UPDATE research_tasks SET source_run_id = 'run_missing' WHERE id = ?").bind(seeded.followupTaskId).run();
    const broken = await verifyRestore({ db: restoredDb, bucket: restoredBucket, manifest: backup.manifest, backupDir: backup.dir });
    assert.equal(broken.ok, false);
    const failed = broken.checks.filter((item) => item.status === "fail").map((item) => item.id).sort();
    assert.deepEqual(failed, ["r2_objects", "r2_references", "relation_content_hashes", "relation_review_followup", "relation_task_source_run"]);
    assert.equal(state.outbound, 0, "no external requests");
  });
});

test("wrangler-export loader: child rows before the parent table, quoted text, triggers and planner stats", { timeout: 60_000 }, async () => {
  // Shape of `wrangler d1 export` output: tables in sqlite_master order, so a
  // child's INSERTs can precede its parent's CREATE TABLE (a plain
  // `wrangler d1 execute --file` replay rejects that with "no such table").
  const dump = [
    "PRAGMA defer_foreign_keys=TRUE;",
    "CREATE TABLE `child` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `parent_id` integer NOT NULL, `note` text,",
    "  FOREIGN KEY (`parent_id`) REFERENCES `parent`(`id`));",
    "INSERT INTO \"child\" VALUES(1,10,'semi; colon -- not a comment');",
    "INSERT INTO \"child\" VALUES(2,10,'line one",
    "line two ''quoted''');",
    "ANALYZE sqlite_schema;",
    "INSERT INTO \"sqlite_stat1\" VALUES('child','x','1');",
    "CREATE TABLE `parent` (`id` integer PRIMARY KEY NOT NULL, `name` text NOT NULL);",
    "INSERT INTO \"parent\" VALUES(10,'p');",
    "DELETE FROM sqlite_sequence;",
    "INSERT INTO \"sqlite_sequence\" VALUES('child',7);",
    "CREATE INDEX `idx_child_parent` ON `child` (`parent_id`);",
    "CREATE TRIGGER protect_parent BEFORE UPDATE ON parent BEGIN SELECT RAISE(ABORT, 'NO; UPDATES'); END;",
    "",
  ].join("\n");
  assert.equal(splitSqlStatements(dump).length, 12);
  const mf = bareStorage("ops-dump-loader");
  try {
    const db = await mf.getD1Database("DB");
    const loaded = await loadSqlDump(db, dump);
    assert.deepEqual(loaded, { tables: 2, rows: 3, sequences: 1, indexesTriggersViews: 2 });
    assert.deepEqual((await db.prepare("SELECT note FROM child ORDER BY id").all()).results.map((row) => row.note),
      ["semi; colon -- not a comment", "line one\nline two 'quoted'"]);
    assert.equal((await db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'child'").first()).seq, 7);
    assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    await assert.rejects(db.prepare("UPDATE parent SET name = 'q'").run(), /NO; UPDATES/);
    await assert.rejects(loadSqlDump(db, dump), RestoreRefusedError, "only into an empty database");
  } finally { await mf.dispose(); }
});
