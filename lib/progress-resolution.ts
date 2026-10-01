export type ProgressResolutionKind = "blocker" | "next_action";
export type ProgressResolutionStatus = "open" | "pending" | "resolved" | "changes_requested";
export type ProgressResolutionAction = "submit" | "confirm" | "request_changes" | "reopen";
// Direct mentor confirmation has its own command; the audit records a confirmation
// from open/changes_requested without inventing a student submission.
export type ProgressResolutionCommand = ProgressResolutionAction | "resolve";

export type ProgressResolutionRow = {
  id: number;
  student_id: string;
  progress_entry_id: number;
  revision_number: number;
  item_kind: ProgressResolutionKind;
  status: ProgressResolutionStatus;
  version: number;
  submission_note: string;
  reviewer_note: string;
  submitted_by_user_id: number | null;
  submitted_at: string | null;
  resolved_at: string | null;
};
export type ProgressResolutionAttachment = { id: number; fileName: string; sizeBytes: number; url: string };
export type ProgressResolutionHistory = {
  id: number;
  action: ProgressResolutionAction;
  note: string;
  actorName: string;
  createdAt: string;
  attachments: ProgressResolutionAttachment[];
};
export type ProgressResolutionItem = {
  studentId?: string;
  studentName?: string;
  key: string;
  progressEntryId: number;
  revisionNumber: number;
  itemKind: ProgressResolutionKind;
  title: string;
  text: string;
  dueDate: string | null;
  trackType: "paper" | "project";
  current: boolean;
  canReview?: boolean;
  status: ProgressResolutionStatus;
  version: number;
  submissionNote: string;
  reviewerNote: string;
  submittedAt: string | null;
  resolvedAt: string | null;
  history: ProgressResolutionHistory[];
};
export function progressResolutionKey(progressEntryId: number, revisionNumber: number, kind: ProgressResolutionKind) {
  return `${progressEntryId}:${revisionNumber}:${kind}`;
}
export function resolutionTransition(status: ProgressResolutionStatus, action: ProgressResolutionCommand): ProgressResolutionStatus | null {
  if (action === "submit" && (status === "open" || status === "changes_requested")) return "pending";
  if (action === "confirm" && status === "pending") return "resolved";
  if (action === "resolve" && (status === "open" || status === "changes_requested")) return "resolved";
  if (action === "request_changes" && (status === "open" || status === "pending" || status === "changes_requested")) return "changes_requested";
  if (action === "reopen" && status === "resolved") return "open";
  return null;
}
