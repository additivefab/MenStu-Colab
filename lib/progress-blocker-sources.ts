/** Problems belong to the revision that recorded them, independently of later progress. */
export function acceptedBlockerSourcesSql(studentCount: number) {
  const ids = Array.from({ length: studentCount }, () => "?").join(",");
  return `WITH scoped_problem_entries AS (
    SELECT p.* FROM progress_entries p
    JOIN students s ON s.id = p.student_id AND s.active = 1
    WHERE p.student_id IN (${ids})
      AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)
  ), problem_revisions AS (
    SELECT p.id, p.student_id, p.current_revision AS latest_revision, p.title AS latest_title,
      r.revision_number, r.reviewed_at AS confirmed_at,
      CASE WHEN json_valid(r.snapshot_json) THEN r.snapshot_json ELSE '{}' END AS snapshot,
      ppd.blocker AS paper_blocker, jpd.blocker AS project_blocker
    FROM scoped_problem_entries p
    JOIN progress_revisions r ON r.progress_entry_id = p.id
    LEFT JOIN paper_progress_details ppd ON ppd.progress_entry_id = p.id
    LEFT JOIN project_progress_details jpd ON jpd.progress_entry_id = p.id
    WHERE r.review_status = 'accepted' AND r.assessment IN ('substantive', 'supporting')
      AND r.reviewed_at IS NOT NULL
      AND (r.revision_number != p.current_revision OR (
        p.review_status = 'accepted' AND p.assessment = r.assessment
      ))
  ), revision_problems AS (
    SELECT id, student_id, revision_number AS current_revision,
      CASE WHEN json_type(snapshot, '$.title') = 'text' THEN json_extract(snapshot, '$.title')
        WHEN revision_number = latest_revision THEN latest_title
        ELSE '进展 #' || id || ' · V' || revision_number END AS title,
      CASE WHEN json_type(snapshot, '$.paper.blocker') = 'text' THEN 'paper'
        WHEN json_type(snapshot, '$.project.blocker') = 'text' THEN 'project'
        WHEN revision_number = latest_revision AND paper_blocker IS NOT NULL THEN 'paper'
        ELSE 'project' END AS track_type,
      CASE WHEN json_type(snapshot, '$.paper.blocker') = 'text' THEN json_extract(snapshot, '$.paper.blocker')
        WHEN json_type(snapshot, '$.project.blocker') = 'text' THEN json_extract(snapshot, '$.project.blocker')
        WHEN revision_number = latest_revision THEN COALESCE(paper_blocker, project_blocker, '')
        ELSE '' END AS blocker,
      confirmed_at, revision_number = latest_revision AS source_current, 0 AS source_priority
    FROM problem_revisions
  ), recorded_problems AS (
    SELECT p.id, p.student_id, pr.revision_number AS current_revision,
      pr.source_title AS title, pr.track_type, pr.source_text AS blocker,
      pr.created_at AS confirmed_at, pr.revision_number = p.current_revision AS source_current,
      1 AS source_priority
    FROM scoped_problem_entries p
    JOIN progress_resolutions pr ON pr.progress_entry_id = p.id AND pr.student_id = p.student_id
      AND pr.item_kind = 'blocker'
  ), all_problem_sources AS (
    SELECT * FROM revision_problems WHERE trim(blocker) != ''
    UNION ALL SELECT * FROM recorded_problems WHERE trim(blocker) != ''
  ), ranked_problem_sources AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY id, current_revision ORDER BY source_priority) AS source_rank
    FROM all_problem_sources
  )
  SELECT id, student_id, current_revision, title, track_type, blocker, confirmed_at, source_current
  FROM ranked_problem_sources WHERE source_rank = 1
  ORDER BY student_id, id, current_revision`;
}
