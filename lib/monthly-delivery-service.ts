import { monthlyDeliverySummarySql } from "./dashboard-overview/query-sql.ts";
import { monthlyDeliveryPhase, monthlyDeliveryWindow, summarizeMonthlyDelivery, type MonthlyDeliverySummary } from "./monthly-delivery.ts";

type Database = Pick<D1Database, "prepare">;
type MonthlyDeliveryRow = {
  student_id: string;
  total: number;
  confirmed: number;
  pending: number;
  needs_changes: number;
  candidates: number;
};

/** Callers provide their authorized student IDs. Only compact counts leave the database. */
export async function readMonthlyDeliveries(database: Database, studentIds: readonly string[], now: string | Date = new Date()): Promise<Map<string, MonthlyDeliverySummary>> {
  const ids = [...new Set(studentIds)];
  const empty = summarizeMonthlyDelivery([], now);
  const result = new Map(ids.map((id) => [id, { ...empty }]));
  const window = monthlyDeliveryWindow(now);
  const boundaries = [window.start, window.end, window.now].map((timestamp) => new Date(timestamp).toISOString());
  // Leave room for the three date parameters under D1's 100-bind limit.
  for (let offset = 0; offset < ids.length; offset += 90) {
    const batch = ids.slice(offset, offset + 90);
    const rows = await database.prepare(monthlyDeliverySummarySql(batch.length))
      .bind(...batch, ...boundaries).all<MonthlyDeliveryRow>();
    for (const row of rows.results) {
      if (!result.has(row.student_id)) continue;
      const counts = {
        total: Number(row.total), confirmed: Number(row.confirmed), pending: Number(row.pending),
        needsChanges: Number(row.needs_changes), candidates: Number(row.candidates),
      };
      result.set(row.student_id, { month: empty.month, phase: monthlyDeliveryPhase(counts), ...counts });
    }
  }
  return result;
}
