export const paperStages = [
  "planning",
  "research",
  "drafting",
  "internal_review",
  "submitted",
  "peer_review",
  "revision",
  "accepted",
  "published",
] as const;

export type PaperStage = (typeof paperStages)[number];

export const paperStageMeta: Record<PaperStage, { label: string; gate: string }> = {
  planning: { label: "选题与计划", gate: "目标、范围、方法和里程碑已明确" },
  research: { label: "实验与证据", gate: "核心数据、实验或分析正在形成" },
  drafting: { label: "初稿撰写", gate: "论文结构和章节内容持续成稿" },
  internal_review: { label: "导师内审", gate: "完整稿进入导师或合作者评阅" },
  submitted: { label: "已投稿/送审", gate: "稿件与必要材料已正式提交" },
  peer_review: { label: "编辑与外审", gate: "记录稿号并跟踪编辑或评审状态" },
  revision: { label: "返修中", gate: "按决定信逐条修改并准备回复" },
  accepted: { label: "已录用", gate: "录用决定已确认，进入出版准备" },
  published: { label: "已发表/归档", gate: "最终版本和公开标识已归档" },
};

export const paperTypes = ["期刊论文", "会议论文", "学位论文"] as const;
export type PaperType = (typeof paperTypes)[number];

export function isPaperStage(value: string): value is PaperStage {
  return paperStages.includes(value as PaperStage);
}

export function isPaperType(value: string): value is PaperType {
  return paperTypes.includes(value as PaperType);
}

export function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function paperDeadlineState(value: string | null, reference = new Date()) {
  if (!value) return { label: "未设投稿日期", overdue: false, days: null as number | null };
  const target = new Date(`${value}T00:00:00+08:00`);
  const current = new Date(reference);
  const days = Math.ceil((target.getTime() - current.getTime()) / 86_400_000);
  if (days < 0) return { label: `逾期 ${Math.abs(days)} 天`, overdue: true, days };
  if (days === 0) return { label: "今天到期", overdue: false, days };
  return { label: `${days} 天后`, overdue: false, days };
}
