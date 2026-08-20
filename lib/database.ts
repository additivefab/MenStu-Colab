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
      reviewer_note TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT
    )`),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_student_submitted ON progress_entries(student_id, submitted_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_status ON progress_entries(status, submitted_at DESC)"),
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
        (student_id, kind, title, summary, evidence, submitted_at, status, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'substantive', ?)`)
      .bind(entry[0], entry[1], entry[2], entry[3], entry[4], isoDaysAgo(student.daysSinceProgress), isoDaysAgo(Math.max(0, student.daysSinceProgress - 1)));
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
