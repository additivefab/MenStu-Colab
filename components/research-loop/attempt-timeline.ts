// Pure helpers for the agent attempt card (frontend plan F4): compress the
// worker event stream into a few milestones, count the folded detail events,
// and pick the agent's own last message as a reference-only summary.
// Tolerates unknown kinds and payload shapes (events come from lab workers
// and older seeds, e.g. `{ status: "started" }` instead of `{ phase }`).

export type TimelineEvent = { sequence: number; kind: string; payload?: Record<string, unknown> | null; createdAt?: string };

export type MilestoneTone = "neutral" | "info" | "good" | "warn" | "bad";

export type Milestone = {
  sequence: number;
  label: string;
  detail: string | null;
  tone: MilestoneTone;
  createdAt: string | null;
};

export type Timeline = {
  milestones: Milestone[];
  /** Folded detail events (message / tool_call / tool_result / file_change / usage, and any unrecognized event). */
  detailCount: number;
  /** Last message event's text, trimmed; reference only, never a metric or conclusion. */
  agentSummary: string | null;
};

const SUMMARY_CHARS = 300;
const DETAIL_CHARS = 160;
/** Kinds that can become milestones; capEvents never drops these. */
const MILESTONE_KINDS = new Set(["status", "test", "error"]);

const outcomeLabels: Record<string, [string, MilestoneTone]> = {
  change_ready: ["已产出修改", "good"],
  completed: ["已完成", "good"],
  failed: ["失败", "bad"],
  canceled: ["已取消", "neutral"],
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clip(value: string, max: number) {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function joinDetail(parts: (string | null | undefined | false)[]) {
  const kept = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
  return kept.length ? kept.join(" · ") : null;
}

function count(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function endMilestone(event: TimelineEvent, payload: Record<string, unknown>, outcome: string | null): Milestone {
  const [outcomeText, tone] = outcome ? outcomeLabels[outcome] ?? [outcome, "neutral" as MilestoneTone] : ["结果未上报", "neutral" as MilestoneTone];
  const errorCode = text(payload.errorCode);
  return {
    sequence: event.sequence, label: "结束", tone: errorCode && tone !== "bad" ? "warn" : tone, createdAt: event.createdAt ?? null,
    detail: joinDetail([outcomeText, errorCode]),
  };
}

function statusMilestone(event: TimelineEvent, payload: Record<string, unknown>): Milestone | null {
  const phase = text(payload.phase) ?? text(payload.status);
  const base = { sequence: event.sequence, createdAt: event.createdAt ?? null };
  switch (phase) {
    case "claimed":
      return { ...base, label: "领取任务", tone: "info", detail: joinDetail([text(payload.modelId)]) };
    case "workspace_ready":
      return { ...base, label: "工作区就绪", tone: "info", detail: text(payload.head) ? `基于 ${String(payload.head).slice(0, 10)}` : null };
    case "agent_started":
    case "started": {
      const minutes = typeof payload.maxAgentMinutes === "number" ? `预算 ${payload.maxAgentMinutes} 分钟` : null;
      return { ...base, label: "代理开始", tone: "info", detail: minutes };
    }
    case "waiting_for_profile":
      return { ...base, label: "等待凭据档案空闲", tone: "warn", detail: null };
    case "cancel_requested_by_platform":
      return { ...base, label: "收到取消请求", tone: "warn", detail: null };
    case "changes_collected": {
      const files = count(payload.files);
      const outside = count(payload.outsideAllowed);
      return {
        ...base, label: "产出修改", tone: outside ? "bad" : "good",
        detail: joinDetail([`${files} 个文件`, outside ? `${outside} 个超出允许范围` : null]),
      };
    }
    case "protected_paths_touched":
      return { ...base, label: "产出修改", tone: "warn", detail: `涉及受保护路径 ${count(payload.paths)} 个，需额外审查` };
    case "result":
      return endMilestone(event, payload, text(payload.outcome));
    case "change_ready":
    case "completed":
    case "failed":
    case "canceled":
      return endMilestone(event, payload, phase);
    default:
      return null;
  }
}

function testMilestone(event: TimelineEvent, payload: Record<string, unknown>): Milestone {
  const command = text(payload.command);
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
  const summary = text(payload.summary);
  return {
    sequence: event.sequence, label: "测试", createdAt: event.createdAt ?? null,
    tone: exitCode === null ? "neutral" : exitCode === 0 ? "good" : "bad",
    detail: joinDetail([
      command ? clip(command, DETAIL_CHARS) : "命令未上报",
      exitCode === null ? "退出码未上报" : `退出码 ${exitCode}`,
      summary ? clip(summary.split("\n").filter((line) => line.trim()).at(-1) ?? summary, 80) : null,
    ]),
  };
}

function errorMilestone(event: TimelineEvent, payload: Record<string, unknown>): Milestone {
  const message = text(payload.message);
  return {
    sequence: event.sequence, label: "错误", tone: "bad", createdAt: event.createdAt ?? null,
    detail: joinDetail([text(payload.code), message ? clip(message, DETAIL_CHARS) : null]),
  };
}

export function buildTimeline(events: readonly TimelineEvent[] | null | undefined): Timeline {
  const milestones: Milestone[] = [];
  let detailCount = 0;
  let agentSummary: string | null = null;
  for (const event of events ?? []) {
    if (!event || typeof event !== "object") continue;
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
    let milestone: Milestone | null = null;
    if (event.kind === "status") milestone = statusMilestone(event, payload);
    else if (event.kind === "test") milestone = testMilestone(event, payload);
    else if (event.kind === "error") milestone = errorMilestone(event, payload);
    else if (event.kind === "message") {
      const said = text(payload.text) ?? text(payload.message);
      if (said) agentSummary = clip(said, SUMMARY_CHARS);
    }
    if (milestone) milestones.push(milestone);
    else detailCount += 1;
  }
  return { milestones, detailCount, agentSummary };
}

/** Keeps at most `max` events, dropping the oldest detail events first so
 * milestones (status / test / error) survive long streams. Order is kept. */
export function capEvents<T extends TimelineEvent>(events: readonly T[], max: number): T[] {
  if (events.length <= max) return [...events];
  let excess = events.length - max;
  const kept: T[] = [];
  for (const event of events) {
    if (excess > 0 && !MILESTONE_KINDS.has(event.kind)) { excess -= 1; continue; }
    kept.push(event);
  }
  return excess > 0 ? kept.slice(excess) : kept;
}

/** Appends a polled page, ignoring events already held (overlapping polls). */
export function mergeEvents<T extends TimelineEvent>(current: T[], incoming: readonly T[], max: number): T[] {
  const last = current.length ? current[current.length - 1].sequence : 0;
  const fresh = incoming.filter((event) => event.sequence > last);
  return fresh.length ? capEvents([...current, ...fresh], max) : current;
}
