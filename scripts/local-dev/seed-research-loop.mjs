// Seeds SYNTHETIC research-loop data into the LOCAL D1/R2 used by `npm run dev`
// so the 科研闭环 UI (task stage bar F1, provenance links F3) can be checked in
// a browser across every stage situation. Usage:
//   npm run db:migrate:local && npm run dev:admin
//   node --experimental-strip-types scripts/local-dev/seed-research-loop.mjs [--reset]
// Scenario list and expected stage per task: scripts/local-dev/README-research-loop-seed.md
//
// - Writes only to .wrangler/state (local Miniflare state). Never hosted data.
// - All names are clearly synthetic ("合成"); no real student data.
// - Creates local logins `synthetic-student` (student) and `synthetic-mentor`
//   (mentor/admin assigned to the synthetic students); their random passwords
//   are appended to the gitignored .local-dev-admin.txt (never printed).
// - GitHub/PR identifiers are fake. GitHub App stays unconfigured locally, so
//   starting an agent or publishing a PR returns GITHUB_NOT_CONFIGURED.
// - Idempotent: when the current seed is present it only prints the expected
//   stage table; `--reset` removes the synthetic rows (and R2 objects) it owns
//   and seeds again. Row ids are deterministic (task_synthS01 …).
import { chmod, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { hashPassword } from "../../lib/local-password.ts";
import {
  agentContextSnapshotSha256, canonicalJson, runSpecSha256, sha256Hex, taskSnapshotSha256,
} from "../../lib/research-loop/contracts.ts";
import { buildTaskSnapshot, parseTaskContent } from "../../lib/research-loop/tasks-core.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const credentialFile = path.join(root, ".local-dev-admin.txt");
const LOCAL_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const ADMIN_OPEN_ID = "local-dev-only:superadmin";
const STUDENT_A = "synthetic-loop-01";
const STUDENT_B = "synthetic-loop-02";
const STUDENT_USERNAME = "synthetic-student";
const MENTOR_USERNAME = "synthetic-mentor";
const MENTOR_OPEN_ID = "local-dev-only:synthetic-mentor";
const REPO_ID = 880001;
const INSTALLATION_ID = 90000001;
const REPO = "synthetic-lab-org/loop-demo";
/** Present only when this version of the seed ran (older seeds lack it). */
const SEED_MARKER_TASK = "task_synthS15b";

const hex = (bytes) => randomBytes(bytes).toString("hex");
const sha40 = () => hex(20);
const sha64 = () => hex(32);
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
/** Same text format as SQLite CURRENT_TIMESTAMP, for *_at columns the app defaults. */
const ts = (minutesAgo) => iso(minutesAgo).slice(0, 19).replace("T", " ");

// ---------------------------------------------------------------------------
// Expected stage situations (printed at the end; mirrored in the README).
// Owner words follow OWNER_LABELS in components/research-loop/stage-model.ts.
// ---------------------------------------------------------------------------
const SCENARIOS = [
  ["S01", "task_synthS01", "草稿从未确认（来自导师意见）", "任务：第 1 版草稿待确认（学生）"],
  ["S02", "task_synthS02", "修订草稿（v1 已确认，v2 草稿）", "任务：第 2 版草稿待确认（学生）；第 1 版曾确认"],
  ["S03", "task_synthS03", "已确认，尚无代理", "代码：待启动代理（学生）"],
  ["S04", "task_synthS04", "代理运行中", "代码：代理运行中（代理）"],
  ["S05", "task_synthS05", "代理失败 POLICY_VIOLATION", "代码：代理失败（POLICY_VIOLATION），需调整后重试（学生）"],
  ["S06", "task_synthS06", "变更触及受保护路径", "代码：变更待额外审查（导师）"],
  ["S07", "task_synthS07", "变更待常规审阅", "代码：变更待审阅发布（学生）"],
  ["S08", "task_synthS08", "PR #8 已发布，无运行", "运行：待登记运行（学生）"],
  ["S09", "task_synthS09", "运行 #1 待批准，较新的 #2 运行中", "运行：运行 #1 待导师批准（导师）——优先于运行 #2 运行中（实验室）"],
  ["S10", "task_synthS10", "运行对账中", "运行：对账中（实验室）"],
  ["S11", "task_synthS11", "运行失败（OOM）", "运行：运行 #1 失败（内存不足），需调整后重跑（学生）"],
  ["S12", "task_synthS12", "运行完成，指标有效", "结果：待导师评审（导师）"],
  ["S13", "task_synthS13", "运行完成，指标无效", "结果：技术无效（评价协议不一致），不能验收，待导师退回或要求跟进（导师）"],
  ["S14", "task_synthS14", "评审已采纳", "下一轮：结果已采纳，待决定关闭或开启下一轮（学生或导师）"],
  ["S15", "task_synthS15", "谱系链：意见→任务→代理→PR→运行→评审（needs_followup）", "下一轮：已创建跟进任务【S15b】（已完成，无人需处理）"],
  ["S15b", "task_synthS15b", "跟进任务（来自运行 #1 的评审）", "任务：第 1 版草稿待确认（学生）；来源：S15 运行 #1 的评审"],
  ["S16", "task_synthS16", "已关闭", "全部完成：任务已关闭（无人需处理）"],
  ["S17", "task_synthS17", "已取消", "任务：已取消，其余阶段不适用（无人需处理）"],
];

function printTable() {
  console.log("\n期望阶段（任务标题 → 状态与负责人），用于与界面对照：");
  for (const [code, id, title, expect] of SCENARIOS) {
    console.log(`  【${code}】${title}\n      id=${id}\n      → ${expect}`);
  }
  console.log("\n登录：学生 synthetic-student（学生视角），导师 synthetic-mentor（导师视角），超级管理员 local-admin；密码见 .local-dev-admin.txt。");
  console.log(`学生档案：/students/${STUDENT_A}`);
}

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
  compatibilityDate: "2025-09-01",
  d1Databases: { DB: LOCAL_DATABASE_ID },
  d1Persist: path.join(root, ".wrangler/state/v3/d1"),
  r2Buckets: { FILES: "site-creator-r2" },
  r2Persist: path.join(root, ".wrangler/state/v3/r2"),
});

async function savePasswords(entries) {
  let text = "";
  try { text = await readFile(credentialFile, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const kept = text.split(/\r?\n/).filter((line) => line && !line.startsWith("synthetic_student_") && !line.startsWith("synthetic_mentor_"));
  for (const [prefix, username, password] of entries) kept.push(`${prefix}_username=${username}`, `${prefix}_password=${password}`);
  kept.push("");
  await writeFile(credentialFile, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
  await chmod(credentialFile, 0o600);
}

async function reset(db, bucket) {
  const ids = `('${STUDENT_A}', '${STUDENT_B}')`;
  const users = `(SELECT id FROM app_users WHERE student_id IN ${ids} OR feishu_open_id LIKE 'local-dev-only:synthetic-%')`;
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
    `DELETE FROM student_guidance_events WHERE guidance_note_id IN (SELECT id FROM student_guidance_notes WHERE student_id IN ${ids})`,
    `DELETE FROM student_guidance_notes WHERE student_id IN ${ids}`,
    `DELETE FROM student_repository_bindings WHERE student_id IN ${ids}`,
    `DELETE FROM mentor_student_assignments WHERE student_id IN ${ids} OR mentor_user_id IN ${users}`,
    // Browser sessions / auth audit of the synthetic logins (FKs to app_users).
    `DELETE FROM app_sessions WHERE app_user_id IN ${users}`,
    `DELETE FROM local_auth_events WHERE app_user_id IN ${users} OR actor_user_id IN ${users}`,
    `DELETE FROM local_credentials WHERE student_id IN ${ids} OR app_user_id IN ${users}`,
    `DELETE FROM app_users WHERE student_id IN ${ids} OR feishu_open_id LIKE 'local-dev-only:synthetic-%'`,
    `DELETE FROM students WHERE id IN ${ids}`,
  ];
  for (const sql of statements) await db.prepare(sql).run();
  for (const prefix of ["agent-attempts/att_synth", "runs/run_synth"]) {
    let cursor;
    do {
      const page = await bucket.list({ prefix, cursor });
      if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

async function main() {
  const db = await mf.getD1Database("DB");
  const bucket = await mf.getR2Bucket("FILES");
  const migrated = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'").first();
  if (!migrated) throw new Error("Local database is not migrated. Run `npm run db:migrate:local` first.");
  const admin = await db.prepare("SELECT id FROM app_users WHERE feishu_open_id = ?").bind(ADMIN_OPEN_ID).first();
  if (!admin) throw new Error("Local superadmin missing. Run `npm run dev:admin` first.");
  const adminId = Number(admin.id);

  if (process.argv.includes("--reset")) await reset(db, bucket);
  else if (await db.prepare("SELECT id FROM students WHERE id = ?").bind(STUDENT_A).first()) {
    if (await db.prepare("SELECT id FROM research_tasks WHERE id = ?").bind(SEED_MARKER_TASK).first()) {
      console.log("Synthetic research-loop data already present (use --reset to recreate).");
      printTable();
    } else {
      console.log("An older synthetic research-loop seed is present; run again with --reset to load the current scenarios.");
      process.exitCode = 1;
    }
    return;
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
      VALUES (?, '合成导师', 'admin', NULL, 1)`).bind(MENTOR_OPEN_ID),
  ]);
  const studentUser = Number((await db.prepare("SELECT id FROM app_users WHERE student_id = ?").bind(STUDENT_A).first()).id);
  const mentorUser = Number((await db.prepare("SELECT id FROM app_users WHERE feishu_open_id = ?").bind(MENTOR_OPEN_ID).first()).id);
  const studentPassword = randomBytes(18).toString("base64url");
  const mentorPassword = randomBytes(18).toString("base64url");
  await db.batch([
    db.prepare(`INSERT INTO local_credentials (app_user_id, student_id, authorized_role, username, password_hash, must_change_password)
      VALUES (?, ?, 'student', ?, ?, 0)`).bind(studentUser, STUDENT_A, STUDENT_USERNAME, await hashPassword(studentPassword)),
    db.prepare(`INSERT INTO local_credentials (app_user_id, student_id, authorized_role, username, password_hash, must_change_password)
      VALUES (?, NULL, 'admin', ?, ?, 0)`).bind(mentorUser, MENTOR_USERNAME, await hashPassword(mentorPassword)),
    db.prepare("INSERT INTO mentor_student_assignments (mentor_user_id, student_id, can_review, active) VALUES (?, ?, 1, 1)").bind(mentorUser, STUDENT_A),
    db.prepare("INSERT INTO mentor_student_assignments (mentor_user_id, student_id, can_review, active) VALUES (?, ?, 1, 1)").bind(mentorUser, STUDENT_B),
    db.prepare(`INSERT INTO student_repository_bindings (student_id, github_username, repository_url, repository_full_name, visibility, last_mutation_id, created_by_user_id)
      VALUES (?, 'synthetic-student-a', 'https://github.com/${REPO}', ?, 'private', 'seed_binding_a', ?)`).bind(STUDENT_A, REPO, adminId),
    db.prepare(`INSERT INTO student_repository_bindings (student_id, github_username, repository_url, repository_full_name, visibility, last_mutation_id, created_by_user_id)
      VALUES (?, 'synthetic-student-b', 'https://github.com/synthetic-lab-org/unlinked-demo', 'synthetic-lab-org/unlinked-demo', 'private', 'seed_binding_b', ?)`).bind(STUDENT_B, adminId),
  ]);
  await savePasswords([["synthetic_student", STUDENT_USERNAME, studentPassword], ["synthetic_mentor", MENTOR_USERNAME, mentorPassword]]);

  // Guidance notes (sources for S15 chain and S01) ------------------------------
  const note = async (title, body, nextAction, criteria, ago) => {
    const row = await db.prepare(`INSERT INTO student_guidance_notes
      (student_id, mentor_user_id, guidance_type, title, content, next_action, acceptance_criteria, created_at, updated_at)
      VALUES (?, ?, 'meeting_followup', ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(STUDENT_A, mentorUser, title, body, nextAction, criteria, ts(ago), ts(ago)).first();
    await db.prepare(`INSERT INTO student_guidance_events (guidance_note_id, actor_user_id, actor_type, action, note, created_at)
      VALUES (?, ?, 'staff', 'created', ?, ?)`).bind(row.id, mentorUser, title, ts(ago)).run();
    return Number(row.id);
  };
  const chainNote = await note("补一组学习率消融（合成）", "基线在验证集上波动较大，建议固定随机种子后比较 3 个学习率。",
    "在 configs/ 下新增学习率网格并跑通评估脚本", "给出 3 个学习率下的 macro_f1，并说明最优设置", 3000);
  const draftNote = await note("整理错误样本（合成）", "组会讨论：先看验证集上最常错的类别，再决定是否调整数据增强。",
    "整理错误样本清单", "列出错误最多的 5 个类别及示例", 600);

  // GitHub (fake identifiers) and lab registry -----------------------------
  const egress = { schema: "tanyan.egress/v1", allowedExtensions: [".csv", ".json", ".log", ".md", ".txt"], maxFileBytes: 5_000_000, maxTotalBytes: 20_000_000, allowImages: false, blockDatasetHashMatches: true };
  const evalSha = sha64();
  await db.batch([
    db.prepare(`INSERT INTO github_installations (installation_id, account_login, account_type, repository_selection, status)
      VALUES (?, 'synthetic-lab-org', 'Organization', 'selected', 'active')`).bind(INSTALLATION_ID),
    db.prepare(`INSERT INTO repository_links (student_id, github_repository_id, installation_id, full_name, default_branch, status, verified_by_user_id)
      VALUES (?, ?, ?, ?, 'main', 'active', ?)`).bind(STUDENT_A, REPO_ID, INSTALLATION_ID, REPO, adminId),
    db.prepare(`INSERT INTO lab_runners (id, label, kind, token_sha256, status, last_seen_at, created_by_user_id)
      VALUES ('rnr_synthagent1', '合成代理工作进程', 'agent', ?, 'active', ?, ?)`).bind(sha64(), iso(3), adminId),
    db.prepare(`INSERT INTO lab_runners (id, label, kind, token_sha256, status, last_seen_at, created_by_user_id)
      VALUES ('rnr_synthcompute1', '合成计算执行器', 'compute', ?, 'active', ?, ?)`).bind(sha64(), iso(2), adminId),
    db.prepare(`INSERT INTO agent_credential_profiles (id, user_id, provider, worker_id, active, created_by_user_id)
      VALUES ('cred_synthstudent', ?, 'codex', 'rnr_synthagent1', 1, ?)`).bind(studentUser, adminId),
    db.prepare(`INSERT INTO registered_entrypoints (id, github_repository_id, name, argv_json, params_schema_json, image_ref, evaluation_protocol_sha256, created_by_user_id)
      VALUES ('ep_synth1', ?, 'train_eval', ?, ?, ?, ?, ?)`)
      .bind(REPO_ID, JSON.stringify(["python", "scripts/train_eval.py"]), canonicalJson({ epochs: { type: "integer", default: 10, minimum: 1, maximum: 200 } }),
        `registry.lab.invalid/loop-demo@sha256:${sha64()}`, evalSha, adminId),
    db.prepare(`INSERT INTO dataset_versions (id, label, runner_id, manifest_sha256, split_manifest_sha256, egress_policy_json, created_by_user_id)
      VALUES ('ds_synth1', '合成数据集 v1', 'rnr_synthcompute1', ?, ?, ?, ?)`).bind(sha64(), sha64(), canonicalJson(egress), adminId),
    db.prepare("INSERT INTO dataset_grants (dataset_version_id, student_id, granted_by_user_id) VALUES ('ds_synth1', ?, ?)").bind(STUDENT_A, adminId),
  ]);
  const dataset = await db.prepare("SELECT manifest_sha256, split_manifest_sha256 FROM dataset_versions WHERE id = 'ds_synth1'").first();
  const entry = await db.prepare("SELECT image_ref FROM registered_entrypoints WHERE id = 'ep_synth1'").first();

  // Builders ------------------------------------------------------------------
  const baseContent = {
    researchQuestion: "固定随机种子后，基线模型在合成验证集上的 macro_f1 是否稳定在 0.80 以上？",
    hypothesis: "固定种子后不同运行之间的 macro_f1 差异小于 0.01。",
    instructions: "在 src/train.py 中加入随机种子参数，并让 scripts/train_eval.py 输出 out/metrics.json（tanyan.metrics/v1）。",
    acceptanceCriteria: "评估脚本可运行，metrics.json 通过校验，macro_f1 与 accuracy 均有记录。",
    allowedPaths: ["configs/**", "scripts/**", "src/**", "tests/**"],
    budget: { maxAgentMinutes: 60, maxGpuCount: 1, maxWalltimeMinutes: 240 },
  };
  const scenarioTitle = (code) => SCENARIOS.find((item) => item[0] === code)[2];
  const titleOf = (code, suffix = "") => `【${code}】${scenarioTitle(code)}${suffix}（合成）`;

  /** Inserts a task with its versions and audit events. `confirmed` is the
   * confirmed version (or null); `end` closes/cancels it afterwards. */
  async function addTask({ code, versions, confirmed = null, end = null, author = studentUser, confirmer = mentorUser,
    sourceGuidanceNoteId = null, sourceRunId = null, parentTaskId = null, ago }) {
    const id = `task_synth${code}`;
    const contents = versions.map((extra) => parseTaskContent({ ...baseContent, ...extra }));
    const shas = [];
    for (const [index, content] of contents.entries()) {
      shas.push(await taskSnapshotSha256(buildTaskSnapshot({ taskId: id, version: index + 1, studentId: STUDENT_A, content })));
    }
    const current = contents.length;
    const status = end === "close" ? "closed" : end === "cancel" ? "canceled" : confirmed === current ? "confirmed" : "draft";
    const statements = [db.prepare(`INSERT INTO research_tasks
      (id, student_id, source_guidance_note_id, source_run_id, parent_task_id, title, status, current_version, confirmed_version,
       created_by_user_id, create_mutation_id, last_mutation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, STUDENT_A, sourceGuidanceNoteId, sourceRunId, parentTaskId, contents[current - 1].title, status, current, confirmed,
        author, `seed_${code}_create`, `seed_${code}_last`, ts(ago), ts(ago - 30 - current * 5))];
    contents.forEach((content, index) => {
      const version = index + 1;
      const isConfirmed = confirmed !== null && version <= confirmed;
      statements.push(db.prepare(`INSERT INTO research_task_versions
        (task_id, version, title, research_question, hypothesis, instructions, acceptance_criteria,
         allowed_paths_json, protected_paths_json, budget_json, snapshot_sha256, author_user_id, confirmed_by_user_id, confirmed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, version, content.title, content.researchQuestion, content.hypothesis, content.instructions, content.acceptanceCriteria,
          JSON.stringify(content.allowedPaths), JSON.stringify(content.protectedPaths), JSON.stringify(content.budget), shas[index], author,
          isConfirmed ? confirmer : null, isConfirmed ? ts(ago - version * 10 + 5) : null, ts(ago - (version - 1) * 10)));
    });
    const event = (version, action, actor, payload, at) => statements.push(db.prepare(`INSERT INTO research_task_events
      (task_id, version, action, actor_type, actor_user_id, payload_json, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?)`)
      .bind(id, version, action, actor, JSON.stringify(payload), ts(at)));
    event(1, "created", author, { snapshotSha256: shas[0], sourceRunId, parentTaskId }, ago);
    contents.forEach((content, index) => {
      const version = index + 1;
      if (version > 1) {
        event(version, "revised", author, { snapshotSha256: shas[index], title: content.title, previousTitle: contents[index - 1].title,
          previousStatus: confirmed !== null && version - 1 <= confirmed ? "confirmed" : "draft", confirmedVersion: confirmed, mutationId: `seed_${code}_rev${version}` }, ago - (version - 1) * 10);
      }
      if (confirmed !== null && version <= confirmed) {
        event(version, "confirmed", confirmer, { snapshotSha256: shas[index], title: content.title,
          previousConfirmedVersion: version > 1 ? version - 1 : null, mutationId: `seed_${code}_conf${version}` }, ago - version * 10 + 5);
      }
    });
    if (end) event(current, end === "close" ? "closed" : "canceled", end === "close" ? confirmer : author,
      { previousStatus: confirmed === current ? "confirmed" : "draft", mutationId: `seed_${code}_last` }, ago - 30 - current * 5);
    await db.batch(statements);
    const confirmedIndex = (confirmed ?? 1) - 1;
    return { id, code, version: confirmed ?? 1, content: contents[confirmedIndex], snapshotSha256: shas[confirmedIndex] };
  }

  /** Stores the change blob the agent-attempts service would store; returns its key/sha. */
  async function storeChange(attemptId, files, unifiedDiff) {
    const normalized = [];
    for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      normalized.push({ path: file.path, action: "modify", mode: "100644", contentBase64: Buffer.from(file.content).toString("base64"), sha256: await sha256Hex(file.content) });
    }
    const changeJson = canonicalJson({ files: normalized, unifiedDiff });
    const key = `agent-attempts/${attemptId}/change.json`;
    const sha = await sha256Hex(changeJson);
    await bucket.put(key, changeJson, { httpMetadata: { contentType: "application/json" }, customMetadata: { attemptId, sha256: sha } });
    return { key, sha, paths: normalized.map((file) => file.path) };
  }

  const baseCommit = sha40();
  /** Agent attempt + its event stream. */
  async function addAttempt(task, { status, ago, change = null, tests = [], changedPaths = [], errorCode = "", errorMessage = "", events = [] }) {
    const id = `att_synth${task.code}`;
    const ended = status === "change_ready" || status === "failed" || status === "canceled";
    const running = status === "running";
    const stored = change ? await storeChange(id, change.files, change.diff) : null;
    const contextSha = await agentContextSnapshotSha256(buildTaskSnapshot({ taskId: task.id, version: task.version, studentId: STUDENT_A, content: task.content }), baseCommit);
    const statements = [db.prepare(`INSERT INTO agent_attempts
      (id, task_id, task_version, student_id, provider, model_id, sdk_version, credential_profile_id, github_repository_id, base_commit_sha,
       context_snapshot_sha256, status, worker_id, lease_epoch, lease_expires_at, heartbeat_at, idempotency_key, diff_sha256, diff_r2_key,
       changed_paths_json, tests_json, error_code, error_message, requested_by_user_id, created_at, started_at, ended_at, updated_at)
      VALUES (?, ?, ?, ?, 'codex', 'synthetic-model', 'synthetic-sdk/0.0', 'cred_synthstudent', ?, ?, ?, ?, 'rnr_synthagent1', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, task.id, task.version, STUDENT_A, REPO_ID, baseCommit, contextSha, status,
        running ? new Date(Date.now() + 24 * 3600_000).toISOString() : null, running ? iso(1) : null, `seed_att_${task.code}`,
        stored?.sha ?? null, stored?.key ?? null, JSON.stringify(stored?.paths ?? changedPaths), JSON.stringify(tests), errorCode, errorMessage,
        studentUser, ts(ago), iso(ago - 1), ended ? iso(ago - 15) : null, ts(ended ? ago - 15 : 1))];
    events.forEach(([kind, payload], index) => statements.push(db.prepare(
      "INSERT INTO agent_attempt_events (attempt_id, sequence, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, index + 1, kind, JSON.stringify(payload), ts(ago - 1 - index))));
    await db.batch(statements);
    return { id, task };
  }

  const standardChange = (code) => ({
    files: [
      { path: "scripts/train_eval.py", content: `# synthetic ${code}\nprint('eval')\n` },
      { path: "src/train.py", content: "import random\ndef set_seed(seed):\n    random.seed(seed)\ndef train():\n    set_seed(13)\n" },
    ],
    diff: "--- a/src/train.py\n+++ b/src/train.py\n@@ -1,3 +1,5 @@\n import random\n+def set_seed(seed):\n+    random.seed(seed)\n def train():\n-    pass\n+    set_seed(13)\n",
  });
  const passingTests = [{ command: "pytest -q tests/test_seed.py", exitCode: 0, summary: "3 passed" }];
  const readyEvents = [
    ["status", { status: "started" }],
    ["message", { text: "读取任务快照，计划修改 src/train.py 与 scripts/train_eval.py（合成事件）" }],
    ["tool_call", { tool: "shell", command: "pytest -q tests/test_seed.py" }],
    ["file_change", { path: "src/train.py" }],
    ["test", { command: "pytest -q tests/test_seed.py", summary: "3 passed" }],
    ["status", { status: "change_ready" }],
  ];

  /** Change request; `pr` publishes it (status open/merged with a PR number). */
  async function addChangeRequest(attempt, { status, pr = null, extraReview = false, ago }) {
    const id = `cr_synth${attempt.task.code}`;
    const head = pr ? sha40() : null;
    await db.prepare(`INSERT INTO change_requests (id, task_id, attempt_id, student_id, github_repository_id, base_commit_sha, branch_name,
        head_commit_sha, pr_number, pr_url, status, requires_extra_review, published_by_user_id, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, attempt.task.id, attempt.id, STUDENT_A, REPO_ID, baseCommit, `tanyan/${attempt.task.id.slice(-8)}/${attempt.id.slice(-8)}`,
        head, pr, pr ? `https://github.com/${REPO}/pull/${pr}` : "", status, extraReview ? 1 : 0, pr ? studentUser : null,
        pr ? (status === "merged" ? 4 : 3) : 1, ts(ago), ts(ago - 5)).run();
    return { id, head, task: attempt.task };
  }

  /** Path of statuses (after awaiting_approval) for each seeded run state. */
  const RUN_PATHS = {
    awaiting_approval: [],
    running: ["queued", "dispatching", "running"],
    reconciling: ["queued", "dispatching", "running", "reconciling"],
    failed: ["queued", "dispatching", "running", "failed"],
    completed: ["queued", "dispatching", "running", "collecting", "completed"],
  };

  /** Run (spec + approval + events). `seq` keeps ids unique within a task. */
  async function addRun(cr, { seq = "a", epochs, status, ago, exitCode = null, failureReason = "" }) {
    const task = cr.task;
    const id = `run_synth${task.code}${seq}`;
    const runSpec = {
      schema: "tanyan.runspec/v1", taskId: task.id, taskVersion: task.version, taskSnapshotSha256: task.snapshotSha256, studentId: STUDENT_A,
      repository: { provider: "github", repositoryId: REPO_ID, fullName: REPO }, executedCommitSha: cr.head, changeRequestId: cr.id,
      entrypoint: { id: "ep_synth1", argv: ["python", "scripts/train_eval.py"], imageRef: entry.image_ref, params: { epochs } },
      dataset: { versionId: "ds_synth1", manifestSha256: dataset.manifest_sha256, splitManifestSha256: dataset.split_manifest_sha256, mount: "read_only" },
      evaluationProtocolSha256: evalSha, resources: { gpuCount: 1, walltimeMinutes: 120, memoryGb: 16 }, network: "deny", egress,
    };
    const sha = await runSpecSha256(runSpec);
    const approved = status !== "awaiting_approval";
    const approvalId = approved ? `apr_synth${task.code}${seq}` : null;
    const path = RUN_PATHS[status];
    const terminal = status === "completed" || status === "failed";
    const statements = [
      db.prepare(`INSERT INTO run_specs (sha256, canonical_json, task_id, task_version, student_id, github_repository_id, executed_commit_sha, entrypoint_id, dataset_version_id, change_request_id, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ep_synth1', 'ds_synth1', ?, ?, ?)`)
        .bind(sha, canonicalJson(runSpec), task.id, task.version, STUDENT_A, REPO_ID, cr.head, cr.id, studentUser, ts(ago)),
    ];
    if (approved) statements.push(db.prepare("INSERT INTO run_approvals (id, run_spec_sha256, approved_by_user_id, note, approved_at) VALUES (?, ?, ?, '合成批准', ?)")
      .bind(approvalId, sha, mentorUser, ts(ago - 5)));
    const leaseEpoch = status === "reconciling" ? 2 : approved ? 1 : 0;
    const leased = status === "running" || status === "reconciling";
    statements.push(db.prepare(`INSERT INTO runs (id, run_spec_sha256, attempt, approval_id, task_id, student_id, status, idempotency_key, submit_tag, runner_id, lease_epoch,
        lease_expires_at, heartbeat_at, scheduler_job_id, exit_code, failure_reason, created_by_user_id, created_at, queued_at, started_at, ended_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, sha, approvalId, task.id, STUDENT_A, status, `seed_run_${task.code}${seq}`, `tanyan-${id}`,
        approved ? "rnr_synthcompute1" : null, leaseEpoch,
        leased ? new Date(Date.now() + 3600_000).toISOString() : null, leased ? iso(1) : null,
        approved ? `synthetic-job-${task.code}${seq}` : null, exitCode, failureReason, studentUser, ts(ago),
        approved ? iso(ago - 5) : null, approved ? iso(ago - 8) : null, terminal ? iso(ago - 40) : null, ts(terminal ? ago - 40 : 1)));
    const payloadFor = (to) => {
      if (to === "queued") return { action: "approved", approvalId, runSpecSha256: sha };
      if (to === "dispatching") return { action: "claim", leaseEpoch: 1 };
      if (to === "running") return { action: "started", schedulerJobId: `synthetic-job-${task.code}${seq}` };
      if (to === "reconciling") return { action: "reconcile_claim", leaseEpoch: 2, previousStatus: "running" };
      return { action: "complete", outcome: status, exitCode };
    };
    let from = "";
    ["awaiting_approval", ...path].forEach((to, index) => {
      const byUser = index === 0 || to === "queued";
      statements.push(db.prepare("INSERT INTO run_events (run_id, sequence, from_status, to_status, actor_type, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, index + 1, from, to, byUser ? "user" : "runner", index === 0 ? String(studentUser) : to === "queued" ? String(mentorUser) : "rnr_synthcompute1",
          JSON.stringify(index === 0 ? { action: "created", runSpecSha256: sha } : payloadFor(to)), ts(ago - index * 5)));
      from = to;
    });
    await db.batch(statements);
    return { id, task };
  }

  /** Result + review for a completed run. `metrics`: "valid" | "protocol_mismatch". */
  async function addResult(run, { metrics = "valid", review = "pending", hypothesis = "not_assessed", note = "", followupTaskId = null, reviewVersion = 1, comment = null }) {
    const valid = metrics === "valid";
    const metricsFile = { schema: "tanyan.metrics/v1", evaluationProtocolSha256: valid ? evalSha : sha64(), split: "val",
      values: valid ? { accuracy: 0.842, macro_f1: 0.811, loss: 0.412 } : { accuracy: 0.861, macro_f1: 0.835, loss: 0.398 } };
    const metricsText = JSON.stringify(metricsFile);
    const logText = "epoch 10 loss=0.412 (synthetic)\n";
    const code = run.task.code;
    const artifacts = [
      { id: `art_synth${code}m`, rel: "metrics.json", kind: "metrics", decision: "published", reason: "", text: metricsText },
      { id: `art_synth${code}l`, rel: "train.log", kind: "log", decision: "published", reason: "", text: logText },
      { id: `art_synth${code}f`, rel: "figures/confusion.png", kind: "figure", decision: "held", reason: "图片默认不外发", size: 48_213 },
    ];
    const statements = [];
    for (const item of artifacts) {
      const sha256 = item.text ? await sha256Hex(item.text) : sha64();
      const r2Key = item.decision === "published" ? `runs/${run.id}/${item.rel}` : null;
      if (r2Key) await bucket.put(r2Key, item.text, { customMetadata: { sha256, runId: run.id } });
      statements.push(db.prepare(`INSERT INTO run_artifacts (id, run_id, relative_path, sha256, size_bytes, kind, egress_decision, egress_reason, r2_key, lab_locator)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(item.id, run.id, item.rel, sha256, item.text ? Buffer.byteLength(item.text) : item.size,
        item.kind, item.decision, item.reason, r2Key, item.decision === "held" ? `lab://synthetic/${run.id}/${item.rel}` : ""));
    }
    const manifestJson = canonicalJson({ synthetic: true, runId: run.id, metricsArtifactPath: "metrics.json" });
    statements.push(
      db.prepare(`INSERT INTO run_results (run_id, manifest_sha256, manifest_json, metrics_json, metrics_source_artifact_id, technical_validity, validity_notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(run.id, await sha256Hex(manifestJson), manifestJson,
        valid ? canonicalJson(metricsFile) : null, valid ? `art_synth${code}m` : null, valid ? "valid" : "invalid",
        valid ? "" : `评价协议不一致：规范 ${evalSha}，metrics ${metricsFile.evaluationProtocolSha256}；不能作为同协议对比`),
      db.prepare(`INSERT INTO result_reviews (run_id, state, hypothesis_outcome, reviewer_user_id, note, followup_task_id, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(run.id, review, hypothesis, review === "pending" ? null : mentorUser, note, followupTaskId, reviewVersion, ts(20)),
    );
    if (comment) statements.push(db.prepare("INSERT INTO result_comments (run_id, author_user_id, body, request_id) VALUES (?, ?, ?, ?)")
      .bind(run.id, mentorUser, comment, `seed_comment_${code}`));
    await db.batch(statements);
  }

  /** Confirmed task whose agent produced a published PR (code stage done). */
  async function publishedTask(code, ago, extra = {}) {
    const task = await addTask({ code, versions: [{ title: titleOf(code) }], confirmed: 1, ago, ...extra });
    const attempt = await addAttempt(task, { status: "change_ready", ago: ago - 20, change: standardChange(code), tests: passingTests, events: readyEvents });
    const cr = await addChangeRequest(attempt, { status: extra.crStatus ?? "open", pr: Number(code.slice(1, 3)), ago: ago - 40 });
    return { task, attempt, cr };
  }

  // Scenarios -----------------------------------------------------------------
  // Larger `ago` = older; tasks list by updated_at DESC, so S01 shows first.
  const agoOf = (index) => 400 + index * 120;

  // S01 draft never confirmed (from a guidance note)
  await addTask({ code: "S01", versions: [{ title: titleOf("S01"), hypothesis: "", budget: {} }], sourceGuidanceNoteId: draftNote, ago: agoOf(1) - 300 });

  // S02 revised draft: v1 confirmed, v2 draft
  await addTask({ code: "S02", versions: [
    { title: titleOf("S02", " v1"), budget: { maxAgentMinutes: 30, maxGpuCount: 1, maxWalltimeMinutes: 120 } },
    { title: titleOf("S02", " v2"), hypothesis: "固定种子并加入 warmup 后，macro_f1 方差下降一半。" },
  ], confirmed: 1, ago: agoOf(2) });

  // S03 confirmed, nothing yet
  await addTask({ code: "S03", versions: [{ title: titleOf("S03") }], confirmed: 1, ago: agoOf(3) });

  // S04 agent running
  {
    const task = await addTask({ code: "S04", versions: [{ title: titleOf("S04") }], confirmed: 1, ago: agoOf(4) });
    await addAttempt(task, { status: "running", ago: 12, events: [
      ["status", { status: "started" }], ["message", { text: "正在分析错误样本（合成事件）" }],
      ["tool_call", { tool: "shell", command: "python scripts/list_errors.py" }],
    ] });
  }

  // S05 agent failed with POLICY_VIOLATION
  {
    const task = await addTask({ code: "S05", versions: [{ title: titleOf("S05") }], confirmed: 1, ago: agoOf(5) });
    await addAttempt(task, { status: "failed", ago: agoOf(5) - 40, changedPaths: ["data/splits/val.txt", "src/train.py"],
      errorCode: "POLICY_VIOLATION", errorMessage: "改动超出任务允许范围：data/splits/val.txt", events: [
        ["status", { status: "started" }], ["file_change", { path: "data/splits/val.txt" }],
        ["error", { message: "修改了任务范围之外的文件 data/splits/val.txt（合成事件）" }],
      ] });
  }

  // S06 change request pending extra review (protected path)
  {
    const task = await addTask({ code: "S06", versions: [{ title: titleOf("S06") }], confirmed: 1, ago: agoOf(6) });
    const attempt = await addAttempt(task, { status: "change_ready", ago: agoOf(6) - 30, tests: passingTests, events: readyEvents, change: {
      files: [{ path: "src/requirements.txt", content: "numpy==2.1.0\n" }, { path: "src/train.py", content: "LR = 0.003\n" }],
      diff: "--- a/src/requirements.txt\n+++ b/src/requirements.txt\n@@ -1 +1 @@\n-numpy==1.26.4\n+numpy==2.1.0\n--- a/src/train.py\n+++ b/src/train.py\n@@ -5 +5 @@\n-LR = 0.01\n+LR = 0.003\n",
    } });
    await addChangeRequest(attempt, { status: "pending_review", extraReview: true, ago: agoOf(6) - 50 });
  }

  // S07 change request pending normal review
  {
    const task = await addTask({ code: "S07", versions: [{ title: titleOf("S07") }], confirmed: 1, ago: agoOf(7) });
    const attempt = await addAttempt(task, { status: "change_ready", ago: agoOf(7) - 30, tests: [{ command: "pytest -q tests/test_plot.py", exitCode: 0, summary: "2 passed" }], events: readyEvents, change: {
      files: [{ path: "scripts/plot_curves.py", content: "# synthetic\nimport json\n" }, { path: "tests/test_plot.py", content: "def test_plot():\n    assert True\n" }],
      diff: "--- /dev/null\n+++ b/scripts/plot_curves.py\n@@ -0,0 +1,2 @@\n+# synthetic\n+import json\n",
    } });
    await addChangeRequest(attempt, { status: "pending_review", ago: agoOf(7) - 50 });
  }

  // S08 published PR (open), no run
  await publishedTask("S08", agoOf(8));

  // S09 run #1 awaiting approval while newer run #2 is running
  {
    const { cr } = await publishedTask("S09", agoOf(9));
    await addRun(cr, { seq: "a", epochs: 30, status: "awaiting_approval", ago: 90 });
    await addRun(cr, { seq: "b", epochs: 10, status: "running", ago: 60 });
  }

  // S10 run reconciling
  {
    const { cr } = await publishedTask("S10", agoOf(10));
    await addRun(cr, { epochs: 20, status: "reconciling", ago: 80 });
  }

  // S11 run failed (OOM)
  {
    const { cr } = await publishedTask("S11", agoOf(11));
    await addRun(cr, { epochs: 50, status: "failed", ago: agoOf(11) - 80, exitCode: 137, failureReason: "调度器报告 OUT_OF_MEMORY：作业超出 16 GB 内存上限被终止（合成）" });
  }

  // S12 completed run pending review (valid metrics)
  {
    const { cr } = await publishedTask("S12", agoOf(12));
    const run = await addRun(cr, { epochs: 10, status: "completed", ago: agoOf(12) - 80, exitCode: 0 });
    await addResult(run, { comment: "合成评论：验证集划分与上次一致吗？" });
  }

  // S13 completed run with invalid metrics (evaluation protocol mismatch)
  {
    const { cr } = await publishedTask("S13", agoOf(13));
    const run = await addRun(cr, { epochs: 10, status: "completed", ago: agoOf(13) - 80, exitCode: 0 });
    await addResult(run, { metrics: "protocol_mismatch" });
  }

  // S14 accepted review awaiting a decision
  {
    const { cr } = await publishedTask("S14", agoOf(14));
    const run = await addRun(cr, { epochs: 10, status: "completed", ago: agoOf(14) - 80, exitCode: 0 });
    await addResult(run, { review: "accepted", hypothesis: "supported", note: "合成评审：结果可采纳，差异小于 0.01。", reviewVersion: 2 });
  }

  // S15 full provenance chain: guidance note → task → attempt → PR → run → review (needs_followup) → S15b
  {
    const { task, cr } = await publishedTask("S15", agoOf(15), { sourceGuidanceNoteId: chainNote });
    const run = await addRun(cr, { epochs: 10, status: "completed", ago: agoOf(15) - 60, exitCode: 0 });
    const followup = await addTask({ code: "S15b", versions: [{
      title: titleOf("S15b"), researchQuestion: "学习率 0.003 与 0.001 的差异是否只来自随机波动？",
      hypothesis: "多跑 3 个种子后，两者 macro_f1 的置信区间重叠。", budget: { maxAgentMinutes: 30, maxGpuCount: 1, maxWalltimeMinutes: 240 },
    }], author: mentorUser, sourceRunId: run.id, parentTaskId: task.id, ago: agoOf(15) - 105 });
    await addResult(run, { review: "needs_followup", hypothesis: "inconclusive", note: "合成评审：差异接近随机波动，需要多种子复核。",
      followupTaskId: followup.id, reviewVersion: 3, comment: "合成评论：请补 3 个随机种子。" });
  }

  // S16 closed task (accepted run, PR merged)
  {
    const { cr } = await publishedTask("S16", agoOf(16), { end: "close", crStatus: "merged" });
    const run = await addRun(cr, { epochs: 10, status: "completed", ago: agoOf(16) - 80, exitCode: 0 });
    await addResult(run, { review: "accepted", hypothesis: "supported", note: "合成评审：已采纳，任务完成。", reviewVersion: 2 });
  }

  // S17 canceled task (draft canceled before any code)
  await addTask({ code: "S17", versions: [{ title: titleOf("S17") }], end: "cancel", ago: agoOf(17) });

  console.log(`Seeded synthetic research-loop data for ${STUDENT_A} (and ${STUDENT_B} without a repository link).`);
  console.log(`Logins "${STUDENT_USERNAME}" and "${MENTOR_USERNAME}"; passwords saved to ${path.relative(process.cwd(), credentialFile) || credentialFile} (not printed).`);
  printTable();
}

try {
  await main();
} finally {
  await mf.dispose();
}
