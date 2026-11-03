// Seeds SYNTHETIC research-loop data into the LOCAL D1/R2 used by `npm run dev`
// so the 科研闭环 UI can be checked in a browser. Usage:
//   npm run db:migrate:local && npm run dev:admin
//   node --experimental-strip-types scripts/local-dev/seed-research-loop.mjs [--reset]
//
// - Writes only to .wrangler/state (local Miniflare state). Never hosted data.
// - All names are clearly synthetic ("合成"); no real student data.
// - Creates a local student login `synthetic-student`; its random password is
//   appended to the gitignored .local-dev-admin.txt (never printed).
// - GitHub/PR identifiers are fake. GitHub App stays unconfigured locally, so
//   starting an agent or publishing a PR returns GITHUB_NOT_CONFIGURED.
// - Idempotent: exits early when already seeded; `--reset` removes the
//   synthetic rows first and seeds again.
import { chmod, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { hashPassword } from "../../lib/local-password.ts";
import { canonicalJson, runSpecSha256, sha256Hex } from "../../lib/research-loop/contracts.ts";
import { createResearchTask } from "../../lib/research-loop/tasks-core.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const credentialFile = path.join(root, ".local-dev-admin.txt");
const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const ADMIN_OPEN_ID = "local-dev-only:superadmin";
const STUDENT_A = "synthetic-loop-01";
const STUDENT_B = "synthetic-loop-02";
const STUDENT_USERNAME = "synthetic-student";
const REPO_ID = 880001;
const INSTALLATION_ID = 90000001;
const REPO = "synthetic-lab-org/loop-demo";
const hex = (bytes) => randomBytes(bytes).toString("hex");
const sha40 = () => hex(20);
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
  compatibilityDate: "2025-09-01",
  d1Databases: { DB: LOCAL_DATABASE_ID },
  d1Persist: path.join(root, ".wrangler/state/v3/d1"),
  r2Buckets: { FILES: "site-creator-r2" },
  r2Persist: path.join(root, ".wrangler/state/v3/r2"),
});

async function saveStudentPassword(password) {
  let text = "";
  try { text = await readFile(credentialFile, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const kept = text.split(/\r?\n/).filter((line) => line && !line.startsWith("synthetic_student_"));
  kept.push(`synthetic_student_username=${STUDENT_USERNAME}`, `synthetic_student_password=${password}`, "");
  await writeFile(credentialFile, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
  await chmod(credentialFile, 0o600);
}

async function reset(db) {
  const ids = `('${STUDENT_A}', '${STUDENT_B}')`;
  const statements = [
    `DELETE FROM result_comments WHERE run_id IN (SELECT id FROM runs WHERE student_id IN ${ids})`,
    `DELETE FROM result_reviews WHERE run_id IN (SELECT id FROM runs WHERE student_id IN ${ids})`,
    `DELETE FROM run_results WHERE run_id IN (SELECT id FROM runs WHERE student_id IN ${ids})`,
    `DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM runs WHERE student_id IN ${ids})`,
    `DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE student_id IN ${ids})`,
    `UPDATE runs SET approval_id = NULL WHERE student_id IN ${ids}`,
    `DELETE FROM run_approvals WHERE run_spec_sha256 IN (SELECT sha256 FROM run_specs WHERE student_id IN ${ids})`,
    `DELETE FROM runs WHERE student_id IN ${ids}`,
    `DELETE FROM run_specs WHERE student_id IN ${ids}`,
    `DELETE FROM change_requests WHERE student_id IN ${ids}`,
    `DELETE FROM agent_attempt_events WHERE attempt_id IN (SELECT id FROM agent_attempts WHERE student_id IN ${ids})`,
    `DELETE FROM agent_attempts WHERE student_id IN ${ids}`,
    `DELETE FROM research_task_events WHERE task_id IN (SELECT id FROM research_tasks WHERE student_id IN ${ids})`,
    `DELETE FROM research_task_versions WHERE task_id IN (SELECT id FROM research_tasks WHERE student_id IN ${ids})`,
    `DELETE FROM research_tasks WHERE student_id IN ${ids}`,
    `DELETE FROM dataset_grants WHERE student_id IN ${ids} OR dataset_version_id LIKE 'ds_synth%'`,
    "DELETE FROM dataset_versions WHERE id LIKE 'ds_synth%'",
    `DELETE FROM registered_entrypoints WHERE github_repository_id = ${REPO_ID}`,
    "DELETE FROM agent_credential_profiles WHERE id LIKE 'cred_synth%'",
    "DELETE FROM lab_runners WHERE id LIKE 'rnr_synth%'",
    `DELETE FROM repository_links WHERE student_id IN ${ids}`,
    `DELETE FROM github_installations WHERE installation_id = ${INSTALLATION_ID}`,
    `DELETE FROM student_guidance_notes WHERE student_id IN ${ids}`,
    `DELETE FROM student_repository_bindings WHERE student_id IN ${ids}`,
    `DELETE FROM mentor_student_assignments WHERE student_id IN ${ids}`,
    `DELETE FROM local_credentials WHERE student_id IN ${ids}`,
    `DELETE FROM app_users WHERE student_id IN ${ids} OR feishu_open_id LIKE 'local-dev-only:synthetic-%'`,
    `DELETE FROM students WHERE id IN ${ids}`,
  ];
  for (const sql of statements) await db.prepare(sql).run();
}

try {
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("FILES");
  const migrated = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'").first();
  if (!migrated) throw new Error("Local database is not migrated. Run `npm run db:migrate:local` first.");
  const admin = await db.prepare("SELECT id FROM app_users WHERE feishu_open_id = ?").bind(ADMIN_OPEN_ID).first();
  if (!admin) throw new Error("Local superadmin missing. Run `npm run dev:admin` first.");
  const adminId = Number(admin.id);

  if (process.argv.includes("--reset")) await reset(db);
  else if (await db.prepare("SELECT id FROM students WHERE id = ?").bind(STUDENT_A).first()) {
    console.log("Synthetic research-loop data already present (use --reset to recreate).");
    process.exit(0);
  }

  // People ------------------------------------------------------------------
  await db.batch([
    db.prepare(`INSERT INTO students (id, display_name, degree, grade_year, stage, current_focus, tracking_started_at)
      VALUES (?, '合成学生甲', '硕士', 2025, '开题', '合成数据：小样本分类基线复现', CURRENT_TIMESTAMP)`).bind(STUDENT_A),
    db.prepare(`INSERT INTO students (id, display_name, degree, grade_year, stage, current_focus, tracking_started_at)
      VALUES (?, '合成学生乙', '博士', 2024, '中期', '合成数据：未链接仓库的对照学生', CURRENT_TIMESTAMP)`).bind(STUDENT_B),
    db.prepare(`INSERT INTO app_users (feishu_open_id, display_name, role, student_id, active)
      VALUES ('local-dev-only:synthetic-student-01', '合成学生甲', 'student', ?, 1)`).bind(STUDENT_A),
    db.prepare(`INSERT INTO app_users (feishu_open_id, display_name, role, student_id, active)
      VALUES ('local-dev-only:synthetic-mentor', '合成导师', 'admin', NULL, 1)`),
  ]);
  const studentUser = Number((await db.prepare("SELECT id FROM app_users WHERE student_id = ?").bind(STUDENT_A).first()).id);
  const mentorUser = Number((await db.prepare("SELECT id FROM app_users WHERE feishu_open_id = 'local-dev-only:synthetic-mentor'").first()).id);
  const password = randomBytes(18).toString("base64url");
  await db.batch([
    db.prepare(`INSERT INTO local_credentials (app_user_id, student_id, authorized_role, username, password_hash, must_change_password)
      VALUES (?, ?, 'student', ?, ?, 0)`).bind(studentUser, STUDENT_A, STUDENT_USERNAME, await hashPassword(password)),
    db.prepare("INSERT INTO mentor_student_assignments (mentor_user_id, student_id, can_review, active) VALUES (?, ?, 1, 1)").bind(mentorUser, STUDENT_A),
    db.prepare("INSERT INTO mentor_student_assignments (mentor_user_id, student_id, can_review, active) VALUES (?, ?, 1, 1)").bind(mentorUser, STUDENT_B),
    db.prepare(`INSERT INTO student_repository_bindings (student_id, github_username, repository_url, repository_full_name, visibility, last_mutation_id, created_by_user_id)
      VALUES (?, 'synthetic-student-a', 'https://github.com/${REPO}', ?, 'private', 'seed_binding_a', ?)`).bind(STUDENT_A, REPO, adminId),
    db.prepare(`INSERT INTO student_repository_bindings (student_id, github_username, repository_url, repository_full_name, visibility, last_mutation_id, created_by_user_id)
      VALUES (?, 'synthetic-student-b', 'https://github.com/synthetic-lab-org/unlinked-demo', 'synthetic-lab-org/unlinked-demo', 'private', 'seed_binding_b', ?)`).bind(STUDENT_B, adminId),
    db.prepare(`INSERT INTO student_guidance_notes (student_id, mentor_user_id, title, content, next_action, acceptance_criteria)
      VALUES (?, ?, '补一组学习率消融（合成）', '基线在验证集上波动较大，建议固定随机种子后比较 3 个学习率。', '在 configs/ 下新增学习率网格并跑通评估脚本', '给出 3 个学习率下的 macro_f1，并说明最优设置')`).bind(STUDENT_A, mentorUser),
  ]);
  await saveStudentPassword(password);

  // GitHub (fake identifiers) and lab registry -----------------------------
  const egress = { schema: "tanyan.egress/v1", allowedExtensions: [".csv", ".json", ".log", ".md", ".txt"], maxFileBytes: 5_000_000, maxTotalBytes: 20_000_000, allowImages: false, blockDatasetHashMatches: true };
  const evalSha = hex(32);
  await db.batch([
    db.prepare(`INSERT INTO github_installations (installation_id, account_login, account_type, repository_selection, status)
      VALUES (?, 'synthetic-lab-org', 'Organization', 'selected', 'active')`).bind(INSTALLATION_ID),
    db.prepare(`INSERT INTO repository_links (student_id, github_repository_id, installation_id, full_name, default_branch, status, verified_by_user_id)
      VALUES (?, ?, ?, ?, 'main', 'active', ?)`).bind(STUDENT_A, REPO_ID, INSTALLATION_ID, REPO, adminId),
    db.prepare(`INSERT INTO lab_runners (id, label, kind, token_sha256, status, last_seen_at, created_by_user_id)
      VALUES ('rnr_synthagent1', '合成代理工作进程', 'agent', ?, 'active', ?, ?)`).bind(hex(32), iso(3), adminId),
    db.prepare(`INSERT INTO lab_runners (id, label, kind, token_sha256, status, last_seen_at, created_by_user_id)
      VALUES ('rnr_synthcompute1', '合成计算执行器', 'compute', ?, 'active', ?, ?)`).bind(hex(32), iso(2), adminId),
    db.prepare(`INSERT INTO agent_credential_profiles (id, user_id, provider, worker_id, active, created_by_user_id)
      VALUES ('cred_synthstudent', ?, 'codex', 'rnr_synthagent1', 1, ?)`).bind(studentUser, adminId),
    db.prepare(`INSERT INTO registered_entrypoints (id, github_repository_id, name, argv_json, params_schema_json, image_ref, evaluation_protocol_sha256, created_by_user_id)
      VALUES ('ep_synth1', ?, 'train_eval', ?, ?, ?, ?, ?)`)
      .bind(REPO_ID, JSON.stringify(["python", "scripts/train_eval.py"]), canonicalJson({ epochs: { type: "integer", default: 10, minimum: 1, maximum: 200 } }),
        `registry.lab.invalid/loop-demo@sha256:${hex(32)}`, evalSha, adminId),
    db.prepare(`INSERT INTO dataset_versions (id, label, runner_id, manifest_sha256, split_manifest_sha256, egress_policy_json, created_by_user_id)
      VALUES ('ds_synth1', '合成数据集 v1', 'rnr_synthcompute1', ?, ?, ?, ?)`).bind(hex(32), hex(32), canonicalJson(egress), adminId),
    db.prepare("INSERT INTO dataset_grants (dataset_version_id, student_id, granted_by_user_id) VALUES ('ds_synth1', ?, ?)").bind(STUDENT_A, adminId),
  ]);

  // Tasks -------------------------------------------------------------------
  const content = {
    title: "复现小样本分类基线（合成）",
    researchQuestion: "固定随机种子后，基线模型在合成验证集上的 macro_f1 是否稳定在 0.80 以上？",
    hypothesis: "固定种子后不同运行之间的 macro_f1 差异小于 0.01。",
    instructions: "在 src/train.py 中加入随机种子参数，并让 scripts/train_eval.py 输出 out/metrics.json（tanyan.metrics/v1）。",
    acceptanceCriteria: "评估脚本可运行，metrics.json 通过校验，macro_f1 与 accuracy 均有记录。",
    allowedPaths: ["scripts/**", "src/**", "tests/**"],
    protectedPaths: [".github/**", ".gitlab-ci.yml", "**/.env", "**/.env.*"],
    budget: { maxAgentMinutes: 60, maxGpuCount: 1, maxWalltimeMinutes: 240 },
  };
  const { parseTaskContent } = await import("../../lib/research-loop/tasks-core.ts");
  const parsed = parseTaskContent(content);
  const { taskId } = await createResearchTask(db, { studentId: STUDENT_A, authorUserId: studentUser, mutationId: `seed_task_${hex(6)}`, content: parsed });
  const snapshot = await db.prepare("SELECT snapshot_sha256 FROM research_task_versions WHERE task_id = ? AND version = 1").bind(taskId).first();
  const confirmMarker = `seed_confirm_${hex(6)}`;
  await db.batch([
    db.prepare("UPDATE research_tasks SET status = 'confirmed', confirmed_version = 1, last_mutation_id = ? WHERE id = ?").bind(confirmMarker, taskId),
    db.prepare("UPDATE research_task_versions SET confirmed_by_user_id = ?, confirmed_at = ? WHERE task_id = ? AND version = 1").bind(mentorUser, iso(300), taskId),
    db.prepare(`INSERT INTO research_task_events (task_id, version, action, actor_type, actor_user_id, payload_json) VALUES (?, 1, 'confirmed', 'user', ?, ?)`)
      .bind(taskId, mentorUser, JSON.stringify({ snapshotSha256: snapshot.snapshot_sha256, mutationId: confirmMarker })),
  ]);
  await createResearchTask(db, {
    studentId: STUDENT_A, authorUserId: mentorUser, mutationId: `seed_task_${hex(6)}`,
    content: parseTaskContent({ ...content, title: "整理错误样本分析（合成，草稿）", hypothesis: "", budget: {} }),
  });

  // Agent attempts and change requests --------------------------------------
  const base = sha40();
  const attempt = (id, status, extra = {}) => db.prepare(`INSERT INTO agent_attempts
      (id, task_id, task_version, student_id, provider, model_id, credential_profile_id, github_repository_id, base_commit_sha,
       context_snapshot_sha256, status, worker_id, lease_epoch, lease_expires_at, heartbeat_at, idempotency_key,
       changed_paths_json, tests_json, error_code, error_message, requested_by_user_id, created_at, started_at, ended_at)
      VALUES (?, ?, 1, ?, 'codex', 'synthetic-model', 'cred_synthstudent', ?, ?, ?, ?, 'rnr_synthagent1', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, taskId, STUDENT_A, REPO_ID, base, hex(32), status, extra.leaseExpiresAt ?? null, extra.heartbeatAt ?? null, `seed_att_${hex(8)}`,
      JSON.stringify(extra.changedPaths ?? []), JSON.stringify(extra.tests ?? []), extra.errorCode ?? "", extra.errorMessage ?? "",
      studentUser, iso(extra.createdAgo ?? 200), iso((extra.createdAgo ?? 200) - 1), extra.ended ? iso((extra.createdAgo ?? 200) - 20) : null);
  const published = "att_synthpublished01";
  const protectedTouch = "att_synthprotected01";
  const failed = "att_synthfailed0001";
  const running = "att_synthrunning001";
  await db.batch([
    attempt(published, "change_ready", { changedPaths: ["scripts/train_eval.py", "src/train.py"], tests: [{ command: "pytest -q tests/test_seed.py", exitCode: 0, summary: "3 passed" }], createdAgo: 240, ended: true }),
    attempt(protectedTouch, "change_ready", { changedPaths: ["src/requirements.txt", "src/train.py"], createdAgo: 120, ended: true }),
    attempt(failed, "failed", { errorCode: "POLICY_VIOLATION", errorMessage: "改动超出允许范围：data/splits/val.txt", createdAgo: 90, ended: true }),
    attempt(running, "running", { leaseExpiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(), heartbeatAt: iso(1), createdAgo: 10 }),
  ]);
  const events = [
    [published, 1, "status", { status: "started" }], [published, 2, "message", { text: "读取任务快照，计划修改 src/train.py 与 scripts/train_eval.py" }],
    [published, 3, "file_change", { path: "src/train.py" }], [published, 4, "test", { command: "pytest -q tests/test_seed.py", summary: "3 passed" }],
    [running, 1, "status", { status: "started" }], [running, 2, "message", { text: "正在分析错误样本（合成事件）" }],
    [failed, 1, "status", { status: "started" }], [failed, 2, "error", { message: "修改了受限文件 data/splits/val.txt" }],
  ];
  await db.batch(events.map(([id, sequence, kind, payload]) => db.prepare(
    "INSERT INTO agent_attempt_events (attempt_id, sequence, kind, payload_json) VALUES (?, ?, ?, ?)").bind(id, sequence, kind, JSON.stringify(payload))));
  const head = sha40();
  const branch = (attemptId) => `tanyan/${taskId.slice(-8)}/${attemptId.slice(-8)}`;
  await db.batch([
    db.prepare(`INSERT INTO change_requests (id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, head_commit_sha, pr_number, pr_url, status, published_by_user_id, version)
      VALUES ('cr_synthopen01', ?, ?, ?, ?, ?, ?, ?, 1, ?, 'open', ?, 3)`)
      .bind(taskId, published, STUDENT_A, REPO_ID, base, branch(published), head, `https://github.com/${REPO}/pull/1`, studentUser),
    db.prepare(`INSERT INTO change_requests (id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name, status, requires_extra_review, version)
      VALUES ('cr_synthreview01', ?, ?, ?, ?, ?, ?, 'pending_review', 1, 1)`)
      .bind(taskId, protectedTouch, STUDENT_A, REPO_ID, base, branch(protectedTouch)),
  ]);
  // Same shape the agent-attempts service stores: full file content + sha256.
  const change = async (files, diff) => JSON.stringify({
    files: await Promise.all(files.map(async (file) => ({
      path: file.path, action: file.action, mode: "100644",
      contentBase64: Buffer.from(file.content).toString("base64"), sha256: await sha256Hex(file.content),
    }))),
    unifiedDiff: diff,
  });
  await bucket.put(`agent-attempts/${published}/change.json`, await change(
    [{ path: "scripts/train_eval.py", action: "modify", content: "# synthetic\nprint('eval')\n" }, { path: "src/train.py", action: "modify", content: "import random\ndef set_seed(seed):\n    random.seed(seed)\ndef train():\n    set_seed(13)\n" }],
    "--- a/src/train.py\n+++ b/src/train.py\n@@ -1,3 +1,5 @@\n import random\n+def set_seed(seed):\n+    random.seed(seed)\n def train():\n-    pass\n+    set_seed(13)\n",
  ));
  await bucket.put(`agent-attempts/${protectedTouch}/change.json`, await change(
    [{ path: "src/requirements.txt", action: "modify", content: "numpy==2.1.0\n" }, { path: "src/train.py", action: "modify", content: "LR = 0.003\n" }],
    "--- a/src/requirements.txt\n+++ b/src/requirements.txt\n@@ -1,2 +1,2 @@\n-numpy==1.26.4\n+numpy==2.1.0\n--- a/src/train.py\n+++ b/src/train.py\n@@ -5 +5 @@\n-LR = 0.01\n+LR = 0.003\n",
  ));

  // Runs ----------------------------------------------------------------------
  const dataset = await db.prepare("SELECT manifest_sha256, split_manifest_sha256 FROM dataset_versions WHERE id = 'ds_synth1'").first();
  const entry = await db.prepare("SELECT image_ref FROM registered_entrypoints WHERE id = 'ep_synth1'").first();
  const spec = (epochs) => ({
    schema: "tanyan.runspec/v1", taskId, taskVersion: 1, taskSnapshotSha256: snapshot.snapshot_sha256, studentId: STUDENT_A,
    repository: { provider: "github", repositoryId: REPO_ID, fullName: REPO }, executedCommitSha: head, changeRequestId: "cr_synthopen01",
    entrypoint: { id: "ep_synth1", argv: ["python", "scripts/train_eval.py"], imageRef: entry.image_ref, params: { epochs } },
    dataset: { versionId: "ds_synth1", manifestSha256: dataset.manifest_sha256, splitManifestSha256: dataset.split_manifest_sha256, mount: "read_only" },
    evaluationProtocolSha256: evalSha, resources: { gpuCount: 1, walltimeMinutes: 120, memoryGb: 16 }, network: "deny", egress,
  });
  const runs = [
    { id: "run_synthcompleted1", epochs: 10, status: "completed", ago: 180 },
    { id: "run_synthfailed0001", epochs: 20, status: "failed", ago: 100 },
    { id: "run_synthawaiting01", epochs: 30, status: "awaiting_approval", ago: 20 },
  ];
  for (const run of runs) {
    const runSpec = spec(run.epochs);
    const sha = await runSpecSha256(runSpec);
    const approvalId = run.status === "awaiting_approval" ? null : `apr_synth${run.epochs}`;
    const statements = [
      db.prepare(`INSERT INTO run_specs (sha256, canonical_json, task_id, task_version, student_id, github_repository_id, executed_commit_sha, entrypoint_id, dataset_version_id, change_request_id, created_by_user_id, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, 'ep_synth1', 'ds_synth1', 'cr_synthopen01', ?, ?)`)
        .bind(sha, canonicalJson(runSpec), taskId, STUDENT_A, REPO_ID, head, studentUser, iso(run.ago)),
    ];
    if (approvalId) statements.push(db.prepare("INSERT INTO run_approvals (id, run_spec_sha256, approved_by_user_id, note, approved_at) VALUES (?, ?, ?, '合成批准', ?)")
      .bind(approvalId, sha, mentorUser, iso(run.ago - 5)));
    statements.push(db.prepare(`INSERT INTO runs (id, run_spec_sha256, attempt, approval_id, task_id, student_id, status, idempotency_key, submit_tag, runner_id, lease_epoch,
        exit_code, failure_reason, created_by_user_id, created_at, queued_at, started_at, ended_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(run.id, sha, approvalId, taskId, STUDENT_A, run.status, `seed_run_${hex(8)}`, `tanyan-${run.id}`,
        approvalId ? "rnr_synthcompute1" : null, approvalId ? 1 : 0,
        run.status === "completed" ? 0 : run.status === "failed" ? 1 : null,
        run.status === "failed" ? "作业退出码 1：显存不足（合成）" : "",
        studentUser, iso(run.ago), approvalId ? iso(run.ago - 5) : null, approvalId ? iso(run.ago - 8) : null, approvalId ? iso(run.ago - 40) : null));
    const statusPath = run.status === "completed" ? ["queued", "dispatching", "running", "collecting", "completed"]
      : run.status === "failed" ? ["queued", "dispatching", "running", "failed"] : [];
    let from = "";
    ["awaiting_approval", ...statusPath].forEach((to, index) => {
      statements.push(db.prepare("INSERT INTO run_events (run_id, sequence, from_status, to_status, actor_type, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)")
        .bind(run.id, index + 1, from, to, index === 0 ? "user" : to === "queued" ? "user" : "runner", index === 0 ? String(studentUser) : to === "queued" ? String(mentorUser) : "rnr_synthcompute1", iso(run.ago - index * 5)));
      from = to;
    });
    await db.batch(statements);

    if (run.status === "completed") {
      const metrics = { schema: "tanyan.metrics/v1", evaluationProtocolSha256: evalSha, split: "val", values: { accuracy: 0.842, macro_f1: 0.811, loss: 0.412 } };
      const metricsText = JSON.stringify(metrics);
      const logText = "epoch 10 loss=0.412 (synthetic)\n";
      const artifacts = [
        { id: "art_synthmetrics01", rel: "metrics.json", kind: "metrics", decision: "published", reason: "", text: metricsText },
        { id: "art_synthlog000001", rel: "train.log", kind: "log", decision: "published", reason: "", text: logText },
        { id: "art_synthfigure001", rel: "figures/confusion.png", kind: "figure", decision: "held", reason: "图片默认不外发", size: 48_213 },
        { id: "art_synthmodel0001", rel: "checkpoints/model.pt", kind: "model", decision: "held", reason: "扩展名不在外发白名单", size: 92_400_000 },
      ];
      const artifactStatements = [];
      for (const item of artifacts) {
        const sha256 = item.text ? await sha256Hex(item.text) : hex(32);
        const r2Key = item.decision === "published" ? `runs/${run.id}/${item.rel}` : null;
        if (r2Key) await bucket.put(r2Key, item.text);
        artifactStatements.push(db.prepare(`INSERT INTO run_artifacts (id, run_id, relative_path, sha256, size_bytes, kind, egress_decision, egress_reason, r2_key, lab_locator)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(item.id, run.id, item.rel, sha256, item.text ? new TextEncoder().encode(item.text).byteLength : item.size,
          item.kind, item.decision, item.reason, r2Key, item.decision === "held" ? `lab://synthetic/${run.id}/${item.rel}` : ""));
      }
      artifactStatements.push(
        db.prepare(`INSERT INTO run_results (run_id, manifest_sha256, manifest_json, metrics_json, metrics_source_artifact_id, technical_validity, validity_notes)
          VALUES (?, ?, '{}', ?, 'art_synthmetrics01', 'valid', '')`).bind(run.id, hex(32), metricsText),
        db.prepare("INSERT INTO result_reviews (run_id, state, hypothesis_outcome) VALUES (?, 'pending', 'not_assessed')").bind(run.id),
        db.prepare("INSERT INTO result_comments (run_id, author_user_id, body, request_id) VALUES (?, ?, '合成评论：验证集划分与上次一致吗？', ?)").bind(run.id, mentorUser, `seed_comment_${hex(6)}`),
      );
      await db.batch(artifactStatements);
    } else if (run.status === "failed") {
      await db.batch([
        db.prepare(`INSERT INTO run_results (run_id, manifest_sha256, manifest_json, metrics_json, metrics_source_artifact_id, technical_validity, validity_notes)
          VALUES (?, ?, '{}', NULL, NULL, 'unknown', '运行失败，没有可校验的指标文件')`).bind(run.id, hex(32)),
        db.prepare("INSERT INTO result_reviews (run_id, state, hypothesis_outcome) VALUES (?, 'pending', 'not_assessed')").bind(run.id),
      ]);
    }
  }

  console.log(`Seeded synthetic research-loop data for ${STUDENT_A} (and ${STUDENT_B} without a repository link).`);
  console.log(`Student login "${STUDENT_USERNAME}"; password saved to ${path.relative(process.cwd(), credentialFile) || credentialFile} (not printed).`);
} finally {
  await mf.dispose();
}
