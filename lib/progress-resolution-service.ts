import { getD1 } from "./database";
import { acceptedTrackProgressSql } from "./dashboard-overview/query-sql";
import { activeBlockerText } from "./progress-blocker";
import { progressResolutionKey, type ProgressResolutionRow, type ProgressResolutionItem, type ProgressResolutionKind, type ProgressResolutionHistory } from "./progress-resolution";

type StoredResolution = ProgressResolutionRow & { source_title: string; source_text: string; source_due_date: string | null; track_type: "paper" | "project" };
export type CurrentResolutionSource = {
  id: number; student_id: string; current_revision: number; title: string;
  track_type: "paper" | "project"; next_action: string; next_action_due_date: string; blocker: string;
};

export async function loadProgressResolutions(studentIds: string[]): Promise<ProgressResolutionRow[]> {
  if (!studentIds.length) return [];
  return (await getD1().prepare(`SELECT pr.* FROM progress_resolutions pr
    JOIN progress_entries p ON p.id = pr.progress_entry_id AND p.student_id = pr.student_id
    WHERE pr.student_id IN (${studentIds.map(() => "?").join(",")})
      AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)
    ORDER BY pr.id`).bind(...studentIds).all<StoredResolution>()).results;
}

export async function loadCurrentResolutionSources(studentId: string): Promise<CurrentResolutionSource[]> {
  return (await getD1().prepare(`SELECT source.*, p.title FROM (${acceptedTrackProgressSql(1)}) source
    JOIN progress_entries p ON p.id = source.id
    JOIN students s ON s.id = source.student_id AND s.active = 1`)
    .bind(studentId).all<CurrentResolutionSource>()).results;
}

export async function loadProgressResolutionItems(studentId: string, entryId?: number): Promise<ProgressResolutionItem[]> {
  const [sources, stored] = await Promise.all([
    loadCurrentResolutionSources(studentId),
    loadProgressResolutions([studentId]) as Promise<StoredResolution[]>,
  ]);
  const eventRows = (await getD1().prepare(`SELECT e.id, e.resolution_id, e.action, e.note, e.created_at,
      u.display_name AS actor_name FROM progress_resolution_events e
    JOIN progress_resolutions pr ON pr.id = e.resolution_id
    JOIN progress_entries p ON p.id = pr.progress_entry_id
    JOIN app_users u ON u.id = e.actor_user_id
    WHERE pr.student_id = ? AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)
    ORDER BY e.id DESC`).bind(studentId).all<{
      id: number; resolution_id: number; action: ProgressResolutionHistory["action"]; note: string; created_at: string; actor_name: string;
    }>()).results;
  const attachments = (await getD1().prepare(`SELECT a.id, a.event_id, a.file_name, a.size_bytes
    FROM progress_resolution_attachments a
    JOIN progress_resolution_events e ON e.id = a.event_id
    JOIN progress_resolutions pr ON pr.id = e.resolution_id
    JOIN progress_entries p ON p.id = pr.progress_entry_id
    WHERE pr.student_id = ? AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)
    ORDER BY a.id`).bind(studentId).all<{ id: number; event_id: number; file_name: string; size_bytes: number }>()).results;
  const items = new Map<string, ProgressResolutionItem>();
  for (const source of sources) {
    for (const itemKind of ["blocker", "next_action"] as ProgressResolutionKind[]) {
      const text = itemKind === "blocker" ? activeBlockerText(source.blocker) : source.next_action.trim();
      if (!text) continue;
      const key = progressResolutionKey(source.id, source.current_revision, itemKind);
      items.set(key, {
        key, progressEntryId: source.id, revisionNumber: source.current_revision, itemKind,
        title: source.title, text, dueDate: itemKind === "next_action" ? source.next_action_due_date || null : null,
        trackType: source.track_type, current: true, status: "open", version: 0,
        submissionNote: "", reviewerNote: "", submittedAt: null, resolvedAt: null, history: [],
      });
    }
  }
  for (const row of stored) {
    const key = progressResolutionKey(row.progress_entry_id, row.revision_number, row.item_kind);
    const source = items.get(key);
    items.set(key, {
      key, progressEntryId: row.progress_entry_id, revisionNumber: row.revision_number, itemKind: row.item_kind,
      title: source?.title ?? row.source_title, text: source?.text ?? row.source_text,
      dueDate: source?.dueDate ?? row.source_due_date, trackType: source?.trackType ?? row.track_type,
      current: Boolean(source), status: row.status, version: row.version,
      submissionNote: row.submission_note, reviewerNote: row.reviewer_note,
      submittedAt: row.submitted_at, resolvedAt: row.resolved_at,
      history: eventRows.filter((event) => event.resolution_id === row.id).map((event) => ({
        id: event.id, action: event.action, note: event.note, actorName: event.actor_name,
        createdAt: event.created_at,
        attachments: attachments.filter((file) => file.event_id === event.id).map((file) => ({
          id: file.id, fileName: file.file_name, sizeBytes: file.size_bytes,
          url: `/api/progress-resolutions/files?id=${file.id}`,
        })),
      })),
    });
  }
  return [...items.values()].filter((item) => entryId === undefined || item.progressEntryId === entryId)
    .sort((a, b) => Number(b.current) - Number(a.current) || b.progressEntryId - a.progressEntryId || a.itemKind.localeCompare(b.itemKind));
}
