function placeholders(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new Error("导师总览一次只支持 1 至 100 名学生");
  }
  return Array.from({ length: count }, () => "?").join(",");
}

export const reviewableStudentSql = `SELECT student_id FROM mentor_student_assignments
  WHERE mentor_user_id = ? AND active = 1 AND can_review = 1
  ORDER BY student_id`;

export function substantiveProgressSql(studentCount: number) {
  const ids = placeholders(studentCount);
  return `WITH authoritative_progress AS (
    SELECT p.id, p.student_id, p.kind, p.title,
      r.reviewed_at AS confirmed_at,
      ROW_NUMBER() OVER (
        PARTITION BY p.student_id
        ORDER BY r.reviewed_at DESC, p.id DESC
      ) AS student_rank
    FROM progress_entries p
    JOIN progress_revisions r
      ON r.progress_entry_id = p.id AND r.revision_number = p.current_revision
    WHERE p.student_id IN (${ids})
      AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)
      AND p.review_status = 'accepted' AND p.assessment = 'substantive' AND p.status = 'substantive'
      AND r.review_status = 'accepted' AND r.assessment = 'substantive'
      AND r.reviewed_at IS NOT NULL
  )
  SELECT id, student_id, kind, title, confirmed_at
  FROM authoritative_progress WHERE student_rank <= 3
  ORDER BY student_id, student_rank`;
}

export function acceptedTrackProgressSql(studentCount: number) {
  const ids = placeholders(studentCount);
  return `WITH accepted_candidates AS (
    SELECT p.id, p.student_id, p.current_revision, p.review_status,
      CASE WHEN ppd.progress_entry_id IS NOT NULL THEN 'paper' ELSE 'project' END AS track_type,
      CASE WHEN ppd.progress_entry_id IS NOT NULL THEN 'paper:' || ppd.paper_id ELSE 'project' END AS track_key,
      COALESCE(ppd.next_action, jpd.next_action, '') AS next_action,
      COALESCE(ppd.next_action_due_date, jpd.next_action_due_date, '') AS next_action_due_date,
      COALESCE(ppd.blocker, jpd.blocker, '') AS blocker,
      r.created_at AS current_revision_created_at,
      r.reviewed_at AS confirmed_at,
      CASE WHEN ppd.progress_entry_id IS NOT NULL THEN current_paper.status IN ('active', 'on_hold')
        WHEN jpd.milestone_id IS NULL THEN 1
        ELSE current_milestone.archived_at IS NULL AND current_milestone.status != 'completed'
          AND current_proposal.status = 'approved' AND current_proposal.current_version = jpd.proposal_version
      END AS action_is_current
    FROM progress_entries p
    JOIN progress_revisions r
      ON r.progress_entry_id = p.id AND r.revision_number = p.current_revision
    LEFT JOIN paper_progress_details ppd ON ppd.progress_entry_id = p.id
    LEFT JOIN student_papers current_paper
      ON current_paper.id = ppd.paper_id AND current_paper.student_id = p.student_id
    LEFT JOIN project_progress_details jpd ON jpd.progress_entry_id = p.id
    LEFT JOIN research_milestones current_milestone
      ON current_milestone.id = jpd.milestone_id
    LEFT JOIN research_proposals current_proposal
      ON current_proposal.id = current_milestone.proposal_id
      AND current_proposal.student_id = p.student_id
    WHERE p.student_id IN (${ids})
      AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)
      AND p.review_status IN ('accepted', 'submitted', 'in_review', 'changes_requested')
      AND r.review_status = p.review_status
      AND (p.review_status != 'accepted' OR (
        p.assessment IN ('substantive', 'supporting') AND r.assessment = p.assessment AND r.reviewed_at IS NOT NULL
      ))
      AND (current_paper.id IS NOT NULL OR current_proposal.id IS NOT NULL
        OR (jpd.progress_entry_id IS NOT NULL AND jpd.milestone_id IS NULL))
  ), accepted_tracks AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY student_id, track_key
      ORDER BY julianday(current_revision_created_at) DESC, id DESC
    ) AS track_rank
    FROM accepted_candidates
  )
  SELECT id, student_id, current_revision, track_type, track_key, next_action, next_action_due_date, blocker,
    current_revision_created_at, confirmed_at
  FROM accepted_tracks WHERE track_rank = 1 AND review_status = 'accepted' AND action_is_current = 1
  ORDER BY student_id, track_key`;
}

export function latestSubmittedSql(studentCount: number) {
  const ids = placeholders(studentCount);
  return `WITH current_submissions AS (
    SELECT p.id, p.student_id, r.created_at AS current_revision_created_at,
      ROW_NUMBER() OVER (
        PARTITION BY p.student_id ORDER BY r.created_at DESC, p.id DESC
      ) AS student_rank
    FROM progress_entries p
    JOIN progress_revisions r
      ON r.progress_entry_id = p.id AND r.revision_number = p.current_revision
    WHERE p.student_id IN (${ids})
      AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)
      AND p.review_status != 'rejected' AND r.review_status != 'rejected'
      AND r.review_status = p.review_status
  )
  SELECT id, student_id, current_revision_created_at
  FROM current_submissions WHERE student_rank = 1
  ORDER BY student_id`;
}

export function outstandingProgressSql(studentCount: number) {
  const ids = placeholders(studentCount);
  return `SELECT p.id, p.student_id, p.title, p.review_status,
    p.submitted_by_user_id, p.reviewed_by_user_id, p.review_claimed_at,
    r.review_status AS revision_review_status,
    r.reviewed_by_user_id AS revision_reviewed_by_user_id,
    r.created_at AS current_revision_created_at,
    CASE WHEN current_paper.id IS NOT NULL THEN 'paper'
      WHEN current_proposal.id IS NOT NULL OR (jpd.progress_entry_id IS NOT NULL AND jpd.milestone_id IS NULL)
        THEN 'project' ELSE NULL END AS track_type,
    CASE WHEN current_paper.id IS NOT NULL THEN 'paper:' || current_paper.id
      WHEN current_proposal.id IS NOT NULL OR (jpd.progress_entry_id IS NOT NULL AND jpd.milestone_id IS NULL)
        THEN 'project' ELSE NULL END AS track_key
  FROM progress_entries p
  JOIN progress_revisions r
    ON r.progress_entry_id = p.id AND r.revision_number = p.current_revision
  LEFT JOIN paper_progress_details ppd ON ppd.progress_entry_id = p.id
  LEFT JOIN student_papers current_paper
    ON current_paper.id = ppd.paper_id AND current_paper.student_id = p.student_id
    AND current_paper.status != 'closed'
  LEFT JOIN project_progress_details jpd ON jpd.progress_entry_id = p.id
  LEFT JOIN research_milestones current_milestone
    ON current_milestone.id = jpd.milestone_id
    AND current_milestone.archived_at IS NULL AND current_milestone.status != 'completed'
  LEFT JOIN research_proposals current_proposal
    ON current_proposal.id = current_milestone.proposal_id
    AND current_proposal.student_id = p.student_id AND current_proposal.status = 'approved'
    AND current_proposal.current_version = jpd.proposal_version
  WHERE p.student_id IN (${ids})
      AND NOT EXISTS (SELECT 1 FROM progress_deletions deleted WHERE deleted.progress_entry_id = p.id)
    AND p.review_status IN ('submitted', 'in_review', 'changes_requested')
    AND r.review_status = p.review_status
    AND (ppd.progress_entry_id IS NULL OR current_paper.id IS NOT NULL)
    AND (jpd.progress_entry_id IS NULL OR jpd.milestone_id IS NULL OR current_proposal.id IS NOT NULL)
  ORDER BY r.created_at, p.id`;
}

export function proposalOverviewSql(studentCount: number) {
  const ids = placeholders(studentCount);
  return `WITH scoped_proposals AS (
    SELECT id, student_id, title, status, current_version, updated_at
    FROM research_proposals WHERE student_id IN (${ids})
  ), latest_versions AS (
    SELECT versions.proposal_id, versions.submitted_by_user_id, versions.created_at,
      ROW_NUMBER() OVER (
        PARTITION BY versions.proposal_id ORDER BY versions.version_number DESC, versions.id DESC
      ) AS version_rank
    FROM research_proposal_versions versions
    JOIN scoped_proposals scoped ON scoped.id = versions.proposal_id
  )
  SELECT rp.id, rp.student_id, rp.title, rp.status, rp.current_version, rp.updated_at,
    version.submitted_by_user_id AS latest_submitted_by_user_id,
    version.created_at AS latest_version_created_at
  FROM scoped_proposals rp
  LEFT JOIN latest_versions version ON version.proposal_id = rp.id AND version.version_rank = 1
  ORDER BY rp.student_id`;
}

export function milestoneOverviewSql(studentCount: number) {
  const ids = placeholders(studentCount);
  return `SELECT m.id, rp.student_id, rp.title AS proposal_title,
    m.title, m.target_date, m.status, m.sort_order, m.updated_at
  FROM research_milestones m
  JOIN research_proposals rp ON rp.id = m.proposal_id
  WHERE rp.student_id IN (${ids}) AND rp.status = 'approved'
    AND m.archived_at IS NULL AND m.status != 'completed'
  ORDER BY rp.student_id,
    CASE m.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
    m.sort_order, m.target_date, m.id`;
}

export function guidanceOverviewSql(studentCount: number) {
  const ids = placeholders(studentCount);
  return `SELECT id, student_id, mentor_user_id, title, next_action, due_date,
    verification_mode, student_reported_at, created_at, updated_at
  FROM student_guidance_notes
  WHERE student_id IN (${ids}) AND status = 'open'
  ORDER BY student_id, created_at, id`;
}

export function paperPositionSql(studentCount: number) {
  const ids = placeholders(studentCount);
  return `WITH ranked_papers AS (
    SELECT id, student_id, title, current_stage, status, updated_at,
      ROW_NUMBER() OVER (
        PARTITION BY student_id
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'accepted' THEN 2 WHEN 'published' THEN 3 ELSE 4 END,
          updated_at DESC, id DESC
      ) AS student_rank
    FROM student_papers
    WHERE student_id IN (${ids}) AND status != 'closed'
  )
  SELECT id, student_id, title, current_stage, status, updated_at
  FROM ranked_papers WHERE student_rank = 1
  ORDER BY student_id`;
}
