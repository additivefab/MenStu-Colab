import { instantTimestamp, shanghaiDateKey } from "./dashboard-overview/dates.ts";

export type MonthlyDeliveryFact = {
  entryId: number;
  revisionNumber: number;
  /** The revision's creation time, never its review time or the entry's initial submission time. */
  submittedAt: string;
  reviewStatus: string;
  aiCandidate?: boolean;
};

export type MonthlyDeliverySummary = {
  month: string;
  phase: "preparing" | "submitted" | "confirmed" | "needs_changes";
  total: number;
  confirmed: number;
  pending: number;
  needsChanges: number;
  candidates: number;
};

export function monthlyDeliveryPhase(counts: Pick<MonthlyDeliverySummary, "confirmed" | "pending" | "needsChanges">): MonthlyDeliverySummary["phase"] {
  if (counts.needsChanges > 0) return "needs_changes";
  if (counts.pending > 0) return "submitted";
  return counts.confirmed > 0 ? "confirmed" : "preparing";
}

export function monthlyDeliveryWindow(now: string | Date) {
  const timestamp = instantTimestamp(now);
  const date = shanghaiDateKey(now);
  if (!date || !Number.isFinite(timestamp)) throw new Error("月度提交统计需要有效的当前时间");
  const month = date.slice(0, 7);
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    month,
    start: Date.UTC(year, monthNumber - 1, 1) - 8 * 60 * 60 * 1000,
    end: Date.UTC(year, monthNumber, 1) - 8 * 60 * 60 * 1000,
    now: timestamp,
  };
}

/** Submission-month progress only; this is not a measure of research or follow-up completion. */
export function summarizeMonthlyDelivery(facts: readonly MonthlyDeliveryFact[], now: string | Date): MonthlyDeliverySummary {
  const window = monthlyDeliveryWindow(now);
  const latest = new Map<number, MonthlyDeliveryFact>();
  for (const fact of facts) {
    const submittedAt = instantTimestamp(fact.submittedAt);
    if (!Number.isFinite(submittedAt) || submittedAt < window.start || submittedAt >= window.end || submittedAt > window.now) continue;
    if (!Number.isInteger(fact.entryId) || fact.entryId < 1 || !Number.isInteger(fact.revisionNumber) || fact.revisionNumber < 1) continue;
    const previous = latest.get(fact.entryId);
    if (!previous || fact.revisionNumber > previous.revisionNumber) latest.set(fact.entryId, fact);
  }

  const summary: MonthlyDeliverySummary = {
    month: window.month, phase: "preparing", total: 0, confirmed: 0, pending: 0, needsChanges: 0, candidates: 0,
  };
  for (const fact of latest.values()) {
    if (!["submitted", "in_review", "accepted", "changes_requested", "rejected"].includes(fact.reviewStatus)) continue;
    if (fact.aiCandidate && fact.reviewStatus !== "accepted") {
      summary.candidates += 1;
      continue;
    }
    summary.total += 1;
    if (fact.reviewStatus === "accepted") summary.confirmed += 1;
    else if (fact.reviewStatus === "submitted" || fact.reviewStatus === "in_review") summary.pending += 1;
    else summary.needsChanges += 1;
  }
  summary.phase = monthlyDeliveryPhase(summary);
  return summary;
}
