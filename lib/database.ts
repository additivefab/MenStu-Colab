import { env } from "cloudflare:workers";

type Degree = "博士" | "硕士";

const DAY = 24 * 60 * 60 * 1000;

const demoStudents = Array.from({ length: 25 }, (_, index) => {
  const isDoctor = index < 12;
  const number = isDoctor ? index + 1 : index - 11;
  const degree: Degree = isDoctor ? "博士" : "硕士";
  const stages = isDoctor
    ? ["文献与选题", "方法开发", "关键实验", "论文撰写", "论文返修"]
    : ["文献与选题", "数据准备", "模型验证", "实验分析", "论文撰写"];
  const focuses = isDoctor
    ? ["射线图像缺陷检测", "跨材料泛化", "低剂量成像增强", "缺陷三维重建"]
    : ["数据标注规范", "模型复现", "实验对照", "工程数据分析"];

  return {
    id: `${isDoctor ? "phd" : "master"}-${String(number).padStart(2, "0")}`,
    displayName: `${degree}生 ${String(number).padStart(2, "0")}`,
    degree,
    gradeYear: isDoctor ? 2022 + (index % 4) : 2024 + (index % 3),
    stage: stages[index % stages.length],
    cadenceDays: [7, 14, 21, 30][index % 4],
    currentFocus: focuses[index % focuses.length],
    daysSinceProgress: [2, 8, 12, 36, 68, 97, 5, 17, 28, 43, 72, 9, 14, 25, 39, 61, 88, 3, 19, 31, 55, 77, 101, 11, 23][index],
  };
});

const demoProgress = [
  ["phd-01", "实验", "完成高噪声条件下三组对照实验", "形成可复现实验表格与初步结论", "实验记录 EXP-0820；结果图 3 张"],
  ["phd-02", "算法", "完成跨材料泛化验证与误差分析", "定位两类主要失效样本", "私有仓库提交 8b4e2d1"],
  ["phd-03", "文献", "完成 6 篇低剂量成像论文深读", "提炼三类增强方法并形成选型建议", "DOI 清单与逐篇阅读卡"],
  ["phd-04", "论文", "完成返修实验方案", "明确两项补充实验的变量与验收条件", "返修任务清单 v2"],
  ["master-01", "数据", "完成厚板缺陷数据标注规范", "统一边界缺陷和伪影的处理规则", "标注规范 v0.3；抽检 120 张"],
  ["master-02", "复现", "复现基线模型并得到首轮指标", "mAP 与论文报告值相差 1.8%", "运行日志 run-240819"],
] as const;

function isoDaysAgo(days: number) {
  return new Date(Date.now() - days * DAY).toISOString();
}

export function getD1() {
  if (!env.DB) {
    throw new Error("D1 binding DB is unavailable");
  }
  return env.DB;
}

async function ensureColumn(table: "progress_entries", column: string, definition: string) {
  const d1 = getD1();
  const { results } = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (results.some((item) => item.name === column)) return;
  try {
    await d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (error) {
    const current = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!current.results.some((item) => item.name === column)) throw error;
  }
}

export async function ensureDatabase() {
  const d1 = getD1();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      degree TEXT NOT NULL,
      grade_year INTEGER NOT NULL,
      stage TEXT NOT NULL,
      cadence_days INTEGER NOT NULL DEFAULT 30,
      current_focus TEXT NOT NULL DEFAULT '',
      last_substantive_at TEXT,
      tracking_started_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      literature_ref TEXT NOT NULL DEFAULT '',
      git_url TEXT NOT NULL DEFAULT '',
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'pending',
      review_status TEXT NOT NULL DEFAULT 'submitted',
      assessment TEXT,
      submitted_by_user_id INTEGER,
      reviewed_by_user_id INTEGER,
      reviewer_note TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feishu_open_id TEXT NOT NULL UNIQUE,
      feishu_union_id TEXT NOT NULL DEFAULT '',
      feishu_user_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'pending',
      student_id TEXT REFERENCES students(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY,
      app_user_id INTEGER NOT NULL REFERENCES app_users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS mentor_student_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      student_id TEXT NOT NULL REFERENCES students(id),
      relationship TEXT NOT NULL DEFAULT 'primary',
      can_review INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_user_role_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_user_id INTEGER NOT NULL REFERENCES app_users(id),
      actor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      request_id TEXT NOT NULL UNIQUE,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS meeting_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      requested_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      preferred_date TEXT NOT NULL,
      preferred_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (15, 30, 45, 60)),
      topic TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'confirmed', 'declined', 'cancelled')),
      handled_by_user_id INTEGER REFERENCES app_users(id),
      response_note TEXT NOT NULL DEFAULT '',
      handled_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id),
      actor_user_id INTEGER REFERENCES app_users(id),
      actor_type TEXT NOT NULL DEFAULT 'user',
      action TEXT NOT NULL,
      from_status TEXT NOT NULL DEFAULT '',
      to_status TEXT NOT NULL DEFAULT '',
      assessment TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      title TEXT NOT NULL DEFAULT '未命名方案',
      scientific_question TEXT NOT NULL DEFAULT '',
      hypothesis TEXT NOT NULL DEFAULT '',
      objectives TEXT NOT NULL DEFAULT '',
      innovation TEXT NOT NULL DEFAULT '',
      literature_basis TEXT NOT NULL DEFAULT '',
      methodology TEXT NOT NULL DEFAULT '',
      data_ethics TEXT NOT NULL DEFAULT '',
      risks TEXT NOT NULL DEFAULT '',
      resources TEXT NOT NULL DEFAULT '',
      references_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      current_version INTEGER NOT NULL DEFAULT 0,
      reviewer_note TEXT NOT NULL DEFAULT '',
      created_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      approved_at TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_proposal_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES research_proposals(id),
      version_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      submitted_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES research_proposals(id),
      title TEXT NOT NULL,
      target_date TEXT NOT NULL,
      evidence_target TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      output_type TEXT NOT NULL,
      title TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL DEFAULT 'planned',
      venue TEXT NOT NULL DEFAULT '',
      identifier TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      linked_milestone_id INTEGER REFERENCES research_milestones(id),
      created_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_output_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      output_id INTEGER NOT NULL REFERENCES research_outputs(id),
      actor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS proposal_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES research_proposals(id),
      actor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS feishu_meeting_summary_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL DEFAULT '',
      sender_type TEXT NOT NULL DEFAULT '',
      message_type TEXT NOT NULL DEFAULT '',
      raw_content TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      detected_reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      message_created_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by_user_id INTEGER REFERENCES app_users(id),
      reviewed_at TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS feishu_meeting_summary_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES feishu_meeting_summary_imports(id),
      student_id TEXT NOT NULL REFERENCES students(id),
      progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_evidence_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id),
      source_type TEXT NOT NULL,
      label TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '',
      source_import_id INTEGER REFERENCES feishu_meeting_summary_imports(id),
      content_sha256 TEXT NOT NULL DEFAULT '',
      occurred_at TEXT,
      created_by_user_id INTEGER REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_student_submitted ON progress_entries(student_id, submitted_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_status ON progress_entries(status, submitted_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_feishu_open_id ON app_users(feishu_open_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_users_role ON app_users(role)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_student_id_unique ON app_users(student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(app_user_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_mentor_student_unique ON mentor_student_assignments(mentor_user_id, student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_mentor_active_students ON mentor_student_assignments(mentor_user_id, active, student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_active_mentors ON mentor_student_assignments(student_id, active, mentor_user_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_user_role_events_target ON app_user_role_events(target_user_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_user_role_events_actor ON app_user_role_events(actor_user_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_requests_student_created ON meeting_requests(student_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_requests_requester_created ON meeting_requests(requested_by_user_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_requests_status_schedule ON meeting_requests(status, preferred_date, preferred_time)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_audit_entry_created ON progress_audit_events(progress_entry_id, created_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_research_proposals_student_unique ON research_proposals(student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_proposals_status_updated ON research_proposals(status, updated_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_versions_proposal_number ON research_proposal_versions(proposal_id, version_number)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_proposal_versions_created ON research_proposal_versions(proposal_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_milestones_proposal_order ON research_milestones(proposal_id, sort_order)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_outputs_student_updated ON research_outputs(student_id, updated_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_outputs_status ON research_outputs(lifecycle_status, updated_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_output_events_output ON research_output_events(output_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_proposal_audit_proposal_created ON proposal_audit_events(proposal_id, created_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_summary_event_unique ON feishu_meeting_summary_imports(event_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_summary_message_unique ON feishu_meeting_summary_imports(message_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_feishu_summary_status_received ON feishu_meeting_summary_imports(status, received_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_summary_link_import_student ON feishu_meeting_summary_links(import_id, student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_feishu_summary_link_student ON feishu_meeting_summary_links(student_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_evidence_entry ON progress_evidence_sources(progress_entry_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_evidence_import ON progress_evidence_sources(source_import_id)"),
  ]);

  await ensureColumn("app_user_role_events", "request_id", "TEXT");
  await d1.batch([
    d1.prepare("UPDATE app_user_role_events SET request_id = 'legacy-' || id WHERE request_id IS NULL OR request_id = ''"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_role_events_request ON app_user_role_events(request_id)"),
  ]);

  await ensureColumn("progress_entries", "review_status", "TEXT NOT NULL DEFAULT 'submitted'");
  await ensureColumn("progress_entries", "assessment", "TEXT");
  await ensureColumn("progress_entries", "submitted_by_user_id", "INTEGER REFERENCES app_users(id)");
  await ensureColumn("progress_entries", "reviewed_by_user_id", "INTEGER REFERENCES app_users(id)");
  await ensureColumn("progress_entries", "updated_at", "TEXT");

  await d1.batch([
    d1.prepare(`UPDATE progress_entries SET
      review_status = CASE status
        WHEN 'substantive' THEN 'accepted'
        WHEN 'supporting' THEN 'accepted'
        WHEN 'supplement' THEN 'changes_requested'
        WHEN 'rejected' THEN 'rejected'
        ELSE 'submitted'
      END,
      assessment = CASE status
        WHEN 'substantive' THEN 'substantive'
        WHEN 'supporting' THEN 'supporting'
        ELSE NULL
      END,
      updated_at = COALESCE(reviewed_at, submitted_at, CURRENT_TIMESTAMP)
      WHERE updated_at IS NULL`),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_review_status ON progress_entries(review_status, submitted_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_reviewer ON progress_entries(reviewed_by_user_id, review_status)"),
    d1.prepare(`INSERT INTO progress_audit_events
      (progress_entry_id, actor_type, action, from_status, to_status, assessment, note, created_at)
      SELECT p.id, 'legacy', 'legacy_review', 'submitted', p.review_status,
        COALESCE(p.assessment, ''), p.reviewer_note, COALESCE(p.reviewed_at, p.submitted_at)
      FROM progress_entries p
      WHERE p.review_status != 'submitted'
        AND NOT EXISTS (SELECT 1 FROM progress_audit_events a WHERE a.progress_entry_id = p.id)`),
    d1.prepare(`INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, source_import_id, occurred_at)
      SELECT l.progress_entry_id,
        CASE WHEN i.raw_content LIKE '%/minutes/%' OR i.extracted_text LIKE '%飞书妙记 AI 会议纪要%' THEN 'feishu_minutes'
          WHEN i.raw_content LIKE '%/docx/%' OR i.extracted_text LIKE '%飞书智能纪要 AI 文档%' THEN 'feishu_docx'
          ELSE 'feishu_message' END,
        CASE WHEN i.raw_content LIKE '%/minutes/%' OR i.extracted_text LIKE '%飞书妙记 AI 会议纪要%' THEN '飞书妙记导入'
          WHEN i.raw_content LIKE '%/docx/%' OR i.extracted_text LIKE '%飞书智能纪要 AI 文档%' THEN '飞书智能纪要文档导入'
          ELSE '飞书智能纪要导入' END,
        '', l.import_id, i.message_created_at
      FROM feishu_meeting_summary_links l
      JOIN feishu_meeting_summary_imports i ON i.id = l.import_id
      WHERE NOT EXISTS (
        SELECT 1 FROM progress_evidence_sources e
        WHERE e.progress_entry_id = l.progress_entry_id AND e.source_import_id = l.import_id
      )`),
    d1.prepare(`INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, occurred_at, created_by_user_id)
      SELECT p.id,
        CASE WHEN p.git_url != '' THEN 'git' WHEN p.literature_ref != '' THEN 'doi' ELSE 'manual' END,
        CASE WHEN p.git_url != '' THEN '历史 Git 证据'
          WHEN p.literature_ref != '' THEN '历史论文或 DOI' ELSE '历史文本证据' END,
        CASE WHEN p.git_url != '' THEN p.git_url WHEN p.literature_ref != '' THEN p.literature_ref ELSE '' END,
        p.submitted_at, p.submitted_by_user_id
      FROM progress_entries p
      WHERE NOT EXISTS (SELECT 1 FROM progress_evidence_sources e WHERE e.progress_entry_id = p.id)`),
    d1.prepare("PRAGMA optimize"),
  ]);

  const count = await d1.prepare("SELECT COUNT(*) AS count FROM students").first<{ count: number }>();
  if ((count?.count ?? 0) > 0) return;

  await d1.batch(
    demoStudents.map((student) =>
      d1
        .prepare(`INSERT INTO students
          (id, display_name, degree, grade_year, stage, cadence_days, current_focus, last_substantive_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          student.id,
          student.displayName,
          student.degree,
          student.gradeYear,
          student.stage,
          student.cadenceDays,
          student.currentFocus,
          isoDaysAgo(student.daysSinceProgress),
        ),
    ),
  );

  const entries = demoProgress.map((entry) => {
    const student = demoStudents.find((item) => item.id === entry[0])!;
    return d1
      .prepare(`INSERT INTO progress_entries
        (student_id, kind, title, summary, evidence, submitted_at, status,
         review_status, assessment, reviewed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'substantive', 'accepted', 'substantive', ?, ?)`)
      .bind(
        entry[0], entry[1], entry[2], entry[3], entry[4],
        isoDaysAgo(student.daysSinceProgress),
        isoDaysAgo(Math.max(0, student.daysSinceProgress - 1)),
        isoDaysAgo(Math.max(0, student.daysSinceProgress - 1)),
      );
  });

  const pending = [
    d1.prepare(`INSERT INTO progress_entries (student_id, kind, title, summary, evidence, submitted_at, status)
      VALUES ('phd-05', '实验', '完成探测器参数敏感性实验', '观察到曝光时间与噪声的非线性关系', '实验记录 EXP-0819', ?, 'pending')`).bind(isoDaysAgo(1)),
    d1.prepare(`INSERT INTO progress_entries (student_id, kind, title, summary, evidence, submitted_at, status)
      VALUES ('master-03', '文献', '阅读缺陷分割相关论文 4 篇', '归纳弱监督与半监督两条技术路线', '含 DOI 与逐篇阅读记录', ?, 'pending')`).bind(isoDaysAgo(2)),
    d1.prepare(`INSERT INTO progress_entries (student_id, kind, title, summary, evidence, submitted_at, status)
      VALUES ('phd-06', '算法', '完成多尺度模块消融实验', '小缺陷召回率提升 2.4%', '私有仓库提交 c9f10ac', ?, 'pending')`).bind(isoDaysAgo(3)),
  ];
  await d1.batch([...entries, ...pending]);
}

export function riskFromDate(value: string | null) {
  if (!value) return { level: "红色", days: 999 };
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / DAY));
  if (days >= 90) return { level: "红色", days };
  if (days >= 60) return { level: "橙色", days };
  if (days >= 30) return { level: "黄色", days };
  return { level: "正常", days };
}
