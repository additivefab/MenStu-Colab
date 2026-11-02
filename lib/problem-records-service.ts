import { acceptedBlockerSourcesSql } from "./progress-blocker-sources.ts";
import { instantTimestamp } from "./dashboard-overview/dates.ts";
import { activeBlockerText } from "./progress-blocker.ts";
import { problemRecordBatches, type ProblemRecord, type ProblemRecordStudent } from "./problem-records.ts";

type Database = Pick<D1Database, "prepare">;
type CurrentProblem = {
  id: number; student_id: string; current_revision: number; title: string; blocker: string;
  track_type: "paper" | "project"; confirmed_at: string | null; source_current: number;
};
type StoredProblem = {
  student_id: string; progress_entry_id: number; revision_number: number;
  source_title: string; source_text: string; source_due_date: string | null; track_type: "paper" | "project";
  status: "open" | "pending" | "changes_requested" | "resolved"; updated_at: string | null;
};
type MilestoneProblem = {
  id: number; student_id: string; title: string; evidence_target: string; proposal_title: string;
  target_date: string | null; updated_at: string | null;
};
type GuidanceProblem = {
  id: number; student_id: string; title: string; content: string; status: "open" | "completed";
  student_reported_at: string | null; verification_mode: "self_report" | "mentor_verify";
  due_date: string | null; updated_at: string | null;
  research_output_id: number | null; research_output_title: string | null; research_output_type: string | null;
};

export type ResearchOutputProblemSummary = {
  problem_count: number;
  problem_status_summary: { open: number; pending: number; resolved: number };
  latest_follow_up_date: string | null;
};

/** Load blocker notes linked to research outputs without broadening the caller's student scope. */
export async function loadResearchOutputProblemSummaries(
  database: Database,
  outputIds: readonly number[],
): Promise<Map<number, ResearchOutputProblemSummary>> {
  const summaries = new Map<number, ResearchOutputProblemSummary>();
  for (const batch of problemRecordBatches([...new Set(outputIds)].filter((id) => Number.isSafeInteger(id) && id > 0))) {
    const placeholders = batch.map(() => "?").join(",");
    let rows: Array<{ research_output_id: number; status: "open" | "pending" | "resolved"; due_date: string | null; updated_at: string | null }> = [];
    try {
      rows = (await database.prepare(`SELECT rol.research_output_id,
          CASE WHEN n.status = 'completed' THEN 'resolved'
            WHEN n.verification_mode = 'mentor_verify' AND n.student_reported_at IS NOT NULL THEN 'pending'
            ELSE 'open' END AS status,
          n.due_date, n.updated_at
        FROM research_output_guidance_links rol
        JOIN student_guidance_notes n ON n.id = rol.guidance_note_id
        WHERE rol.research_output_id IN (${placeholders}) AND n.guidance_type = 'blocker'`)
        .bind(...batch).all<{ research_output_id: number; status: "open" | "pending" | "resolved"; due_date: string | null; updated_at: string | null }>()).results;
    } catch (error) {
      // Keep reads compatible with databases created before output links existed.
      if (!/research_output_guidance_links|no such table|no such column/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    for (const id of batch) summaries.set(id, { problem_count: 0, problem_status_summary: { open: 0, pending: 0, resolved: 0 }, latest_follow_up_date: null });
    for (const row of rows) {
      const summary = summaries.get(Number(row.research_output_id)) ?? { problem_count: 0, problem_status_summary: { open: 0, pending: 0, resolved: 0 }, latest_follow_up_date: null };
      summary.problem_count += 1;
      summary.problem_status_summary[row.status] += 1;
      const followUpDate = row.due_date || row.updated_at?.slice(0, 10) || null;
      if (followUpDate && (!summary.latest_follow_up_date || followUpDate > summary.latest_follow_up_date)) summary.latest_follow_up_date = followUpDate;
      summaries.set(Number(row.research_output_id), summary);
    }
  }
  return summaries;
}

async function loadGuidanceProblems(database: Database, batch: string[], placeholders: string) {
  try {
    return { results: (await database.prepare(`SELECT n.id, n.student_id, n.title, n.content, n.status, n.student_reported_at,
        n.verification_mode, n.due_date, n.updated_at, rol.research_output_id,
        ro.title AS research_output_title, ro.output_type AS research_output_type
      FROM student_guidance_notes n
      LEFT JOIN research_output_guidance_links rol ON rol.guidance_note_id = n.id
      LEFT JOIN research_outputs ro ON ro.id = rol.research_output_id
      WHERE n.student_id IN (${placeholders}) AND n.guidance_type = 'blocker'`)
      .bind(...batch).all<GuidanceProblem>()).results };
  } catch (error) {
    // Existing v25 local databases are upgraded lazily by database bootstrap.
    // Keep this read compatible while the additive column is being installed.
    if (!/research_output_guidance_links|research_output_id|no such table|no such column/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return { results: (await database.prepare(`SELECT n.id, n.student_id, n.title, n.content, n.status, n.student_reported_at,
        n.verification_mode, n.due_date, n.updated_at,
        NULL AS research_output_id, NULL AS research_output_title, NULL AS research_output_type
      FROM student_guidance_notes n
      WHERE n.student_id IN (${placeholders}) AND n.guidance_type = 'blocker'`)
      .bind(...batch).all<GuidanceProblem>()).results };
  }
}

function progressKey(entryId: number, revision: number) {
  return `progress:${entryId}:${revision}:blocker`;
}

/** Read compact source rows in student batches; event histories and files stay in their existing detail views. */
export async function loadProblemRecords(database: Database, students: readonly ProblemRecordStudent[]): Promise<ProblemRecord[]> {
  const byStudent = new Map(students.map((student) => [student.id, student]));
  const records = new Map<string, ProblemRecord>();
  for (const batch of problemRecordBatches([...byStudent.keys()])) {
    const placeholders = batch.map(() => "?").join(",");
    const [current, stored, milestones, guidance] = await Promise.all([
      database.prepare(`SELECT source.id, source.student_id, source.current_revision, source.track_type,
          source.blocker, source.confirmed_at, source.source_current, source.title
        FROM (${acceptedBlockerSourcesSql(batch.length)}) source
        JOIN progress_entries p ON p.id = source.id AND p.student_id = source.student_id`)
        .bind(...batch).all<CurrentProblem>(),
      database.prepare(`SELECT pr.student_id, pr.progress_entry_id, pr.revision_number,
          pr.source_title, pr.source_text, pr.source_due_date, pr.track_type, pr.status, pr.updated_at
        FROM progress_resolutions pr
        JOIN progress_entries p ON p.id = pr.progress_entry_id AND p.student_id = pr.student_id
        WHERE pr.student_id IN (${placeholders}) AND pr.item_kind = 'blocker'
          AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)`)
        .bind(...batch).all<StoredProblem>(),
      database.prepare(`SELECT m.id, rp.student_id, m.title, m.evidence_target, rp.title AS proposal_title,
          m.target_date, m.updated_at
        FROM research_milestones m JOIN research_proposals rp ON rp.id = m.proposal_id
        WHERE rp.student_id IN (${placeholders}) AND rp.status = 'approved'
          AND m.status = 'blocked' AND m.archived_at IS NULL`)
        .bind(...batch).all<MilestoneProblem>(),
      loadGuidanceProblems(database, batch, placeholders),
    ]);
    for (const row of current.results) {
      const student = byStudent.get(row.student_id);
      const content = activeBlockerText(row.blocker);
      if (!student || !content) continue;
      const id = progressKey(row.id, row.current_revision);
      records.set(id, {
        id, studentId: student.id, studentName: student.name, source: "progress",
        title: row.title, content, status: "open", current: true, updatedAt: row.confirmed_at, dueDate: null,
        sourceCurrent: row.source_current !== 0,
        href: `/students/${encodeURIComponent(student.id)}#progress-resolution-${row.id}-blocker-revision-${row.current_revision}`,
        trackType: row.track_type,
      });
    }
    for (const row of stored.results) {
      const student = byStudent.get(row.student_id);
      if (!student) continue;
      const id = progressKey(row.progress_entry_id, row.revision_number);
      const source = records.get(id);
      records.set(id, {
        id, studentId: student.id, studentName: student.name, source: "progress",
        title: source?.title ?? row.source_title, content: source?.content ?? row.source_text,
        status: row.status,
        originalStatus: row.status, current: Boolean(source), updatedAt: row.updated_at,
        sourceCurrent: source?.sourceCurrent ?? false,
        dueDate: row.source_due_date || null, trackType: source?.trackType ?? row.track_type,
        href: source?.href ?? `/students/${encodeURIComponent(student.id)}#progress-resolution-${row.progress_entry_id}-blocker-revision-${row.revision_number}`,
      });
    }
    for (const row of milestones.results) {
      const student = byStudent.get(row.student_id);
      if (!student) continue;
      const id = `milestone:${row.id}`;
      records.set(id, {
        id, studentId: student.id, studentName: student.name, source: "milestone", title: row.title,
        content: `培养节点受阻 · ${row.proposal_title}${row.evidence_target ? `\n完成标准：${row.evidence_target}` : ""}`,
        status: "open", current: true, updatedAt: row.updated_at, dueDate: row.target_date || null,
        href: `/students/${encodeURIComponent(student.id)}#milestone-${row.id}`,
      });
    }
    for (const row of guidance.results) {
      const student = byStudent.get(row.student_id);
      if (!student) continue;
      const id = `guidance:${row.id}`;
      records.set(id, {
        id, studentId: student.id, studentName: student.name, source: "guidance",
        title: row.title || row.content.split("\n")[0].slice(0, 120) || "问题记录", content: row.content,
        status: row.status === "completed" ? "resolved"
          : row.verification_mode === "mentor_verify" && row.student_reported_at ? "pending" : "open",
        current: true, updatedAt: row.updated_at, dueDate: row.due_date || null,
        href: `/students/${encodeURIComponent(student.id)}#guidance-${row.id}`,
        researchOutputId: row.research_output_id ?? undefined,
        researchOutputTitle: row.research_output_title ?? undefined,
        researchOutputType: row.research_output_type ?? undefined,
      });
    }
  }
  const statusOrder = { open: 0, changes_requested: 1, pending: 2, resolved: 3, historical: 4 };
  const timestamp = (value: string | null) => {
    const parsed = value ? instantTimestamp(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...records.values()].sort((left, right) => statusOrder[left.status] - statusOrder[right.status]
    || timestamp(right.updatedAt) - timestamp(left.updatedAt) || left.id.localeCompare(right.id));
}
