export type ProblemRecordSource = "progress" | "milestone" | "guidance";
export type ProblemRecordStatus = "open" | "pending" | "changes_requested" | "resolved" | "historical";

export type ProblemRecord = {
  id: string;
  studentId: string;
  studentName: string;
  source: ProblemRecordSource;
  title: string;
  content: string;
  status: ProblemRecordStatus;
  current: boolean;
  sourceCurrent?: boolean;
  updatedAt: string | null;
  dueDate: string | null;
  href: string;
  trackType?: "paper" | "project";
  /** Superseded unresolved records stay historical without losing their original status. */
  originalStatus?: Exclude<ProblemRecordStatus, "historical">;
};

export type ProblemRecordStudent = { id: string; name: string; stage: string; canRecord: boolean };
export type ProblemRecordsPayload = { records: ProblemRecord[]; students: ProblemRecordStudent[]; generatedAt: string };

export const problemRecordBatchSize = 90;

export function problemRecordBatches<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let offset = 0; offset < items.length; offset += problemRecordBatchSize) {
    batches.push(items.slice(offset, offset + problemRecordBatchSize));
  }
  return batches;
}
