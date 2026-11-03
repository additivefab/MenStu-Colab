import { instantTimestamp } from "../../lib/dashboard-overview/dates";

// Chinese labels. A technically completed run is "执行结束", never "已验收":
// human acceptance lives only on the result review.

export type Tone = "neutral" | "info" | "good" | "warn" | "bad";

export const taskStatusLabels: Record<string, [string, Tone]> = {
  draft: ["待确认", "warn"],
  confirmed: ["已确认", "good"],
  closed: ["已关闭", "neutral"],
  canceled: ["已取消", "neutral"],
};

export const attemptStatusLabels: Record<string, [string, Tone]> = {
  queued: ["排队中", "info"],
  running: ["运行中", "info"],
  waiting_approval: ["等待批准", "warn"],
  change_ready: ["已产出修改", "good"],
  failed: ["失败", "bad"],
  cancel_requested: ["正在取消", "warn"],
  canceled: ["已取消", "neutral"],
};

export const changeRequestStatusLabels: Record<string, [string, Tone]> = {
  pending_review: ["待审阅", "warn"],
  publishing: ["发布中", "info"],
  open: ["PR 已开启", "good"],
  merged: ["已合并", "good"],
  closed: ["PR 已关闭", "neutral"],
  rejected: ["已驳回", "neutral"],
  failed: ["发布失败", "bad"],
};

export const runStatusLabels: Record<string, [string, Tone]> = {
  awaiting_approval: ["待批准", "warn"],
  queued: ["已批准，排队中", "info"],
  dispatching: ["派发中", "info"],
  running: ["运行中", "info"],
  collecting: ["回收结果中", "info"],
  completed: ["执行结束", "neutral"],
  failed: ["运行失败", "bad"],
  cancel_requested: ["正在取消", "warn"],
  canceled: ["已取消", "neutral"],
  reconciling: ["对账中", "info"],
};

export const validityLabels: Record<string, [string, Tone]> = {
  valid: ["技术有效", "good"],
  invalid: ["技术无效", "bad"],
  unknown: ["技术有效性未知", "warn"],
};

export const reviewStateLabels: Record<string, [string, Tone]> = {
  pending: ["待导师评审", "warn"],
  accepted: ["导师已验收", "good"],
  rejected: ["导师未采纳", "bad"],
  needs_followup: ["需要后续实验", "info"],
};

export const hypothesisLabels: Record<string, string> = {
  not_assessed: "尚未判断",
  supported: "支持假设",
  not_supported: "不支持假设",
  inconclusive: "结论不确定",
  not_applicable: "不适用",
};

export const egressLabels: Record<string, [string, Tone]> = {
  published: ["已外发", "good"],
  held: ["保留在实验室", "neutral"],
  rejected: ["禁止外发", "bad"],
};

export const providerLabels: Record<string, string> = { codex: "Codex", claude: "Claude", deepseek: "DeepSeek" };

export const artifactKindLabels: Record<string, string> = {
  metrics: "指标", figure: "图", table: "表", log: "日志", model: "模型", other: "其他",
};

export function label(map: Record<string, [string, Tone]>, value: string | null | undefined): [string, Tone] {
  if (!value) return ["—", "neutral"];
  return map[value] ?? [value, "neutral"];
}

export function shortSha(value: string | null | undefined, length = 10) {
  return value ? value.slice(0, length) : "—";
}

export function dateLabel(value: string | null | undefined) {
  if (!value) return "—";
  const timestamp = instantTimestamp(value);
  if (!Number.isFinite(timestamp)) return value.slice(0, 16);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(timestamp));
}

export function bytesLabel(bytes: number) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Hints for the server's error codes, shown next to the server message. */
export const errorHints: Record<string, string> = {
  TASK_NOT_CONFIRMED: "请先确认任务的最新版本。",
  REPOSITORY_NOT_LINKED: "需要超级管理员在“系统管理 · GitHub 仓库”中完成仓库授权链接。",
  CREDENTIAL_PROFILE_MISSING: "需要超级管理员为你的账号登记代理凭据档案。",
  GITHUB_NOT_CONFIGURED: "需超级管理员在 Worker secrets 中配置 GitHub App 后才能使用。",
  EXTRA_REVIEW_REQUIRED: "修改涉及受保护路径，需导师先完成额外审查。",
  NOT_TECHNICALLY_VALID: "技术有效性未通过的结果不能验收。",
  SPEC_HASH_MISMATCH: "运行规范已变化，请刷新后重新审阅。",
  PLAN_REJECTED: "修改计划已被退回，本次尝试已取消；可调整任务后重新发起。",
  PLAN_MODE_EDITED: "该尝试处于“先出计划”阶段，代理不应在计划批准前修改文件；请重新发起尝试。",
};

/** FB2 plan decision states shown on the attempt card. */
export const planDecisionLabels: Record<string, [string, Tone]> = {
  awaiting_plan: ["待代理提交计划", "info"],
  pending: ["待审阅计划", "warn"],
  approved: ["已批准（进入修改阶段）", "good"],
  rejected: ["已退回", "neutral"],
};
