import { getD1 } from "./database";

export function importedProgressSnapshot(input: {
  title: string;
  summary: string;
  evidence: string;
}) {
  return JSON.stringify({
    kind: "组会",
    title: input.title,
    summary: input.summary,
    evidence: input.evidence,
    literatureRef: "",
    gitUrl: "",
    attachments: [],
    paper: null,
    project: null,
  });
}

export async function removeImportedProgress(progressEntryId: number) {
  const d1 = getD1();
  await d1.batch([
    d1.prepare("DELETE FROM feishu_meeting_summary_links WHERE progress_entry_id = ?").bind(progressEntryId),
    d1.prepare("DELETE FROM progress_evidence_sources WHERE progress_entry_id = ?").bind(progressEntryId),
    d1.prepare("DELETE FROM progress_audit_events WHERE progress_entry_id = ?").bind(progressEntryId),
    d1.prepare("DELETE FROM progress_revisions WHERE progress_entry_id = ?").bind(progressEntryId),
    d1.prepare("DELETE FROM progress_entries WHERE id = ? AND status = 'pending'").bind(progressEntryId),
  ]);
}
