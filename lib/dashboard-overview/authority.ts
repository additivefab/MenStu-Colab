export type AcceptedTrackAuthority = {
  id: number;
  track_type: "paper" | "project";
  track_key: string;
  current_revision_created_at: string;
};

export type OutstandingTrackAuthority = {
  id: number;
  track_type: "paper" | "project" | null;
  track_key: string | null;
  current_revision_created_at: string;
};

function instantOrder(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function reviewLeaseExpired(value: string | null, now: string | Date) {
  if (!value) return true;
  const lease = instantOrder(value);
  const reference = now instanceof Date ? now.getTime() : instantOrder(now);
  return !Number.isFinite(lease) || lease === Number.NEGATIVE_INFINITY || reference - lease >= 30 * 60 * 1000;
}

export function canActOnProgressReview(
  row: {
    review_status: "submitted" | "in_review" | "changes_requested";
    submitted_by_user_id: number | null;
    reviewed_by_user_id: number | null;
    review_claimed_at: string | null;
    revision_review_status: "submitted" | "in_review" | "changes_requested";
    revision_reviewed_by_user_id: number | null;
  },
  viewerId: number,
  canReview: boolean,
  now: string | Date,
) {
  if (!canReview || row.submitted_by_user_id === viewerId || row.revision_review_status !== row.review_status) return false;
  if (row.review_status === "submitted") return true;
  if (row.review_status !== "in_review") return false;
  if (row.revision_reviewed_by_user_id !== row.reviewed_by_user_id) return false;
  return row.reviewed_by_user_id === viewerId || reviewLeaseExpired(row.review_claimed_at, now);
}

export function canActOnProposalReview(
  status: string,
  latestSubmittedByUserId: number | null,
  viewerId: number,
  canReview: boolean,
) {
  return status === "submitted" && canReview && latestSubmittedByUserId !== viewerId;
}

export function canVerifyGuidance(
  row: { verification_mode: string; student_reported_at: string | null; mentor_user_id: number },
  viewerId: number,
  canReview: boolean,
) {
  return row.verification_mode === "mentor_verify" && Boolean(row.student_reported_at)
    && (row.mentor_user_id === viewerId || canReview);
}

export function filterCurrentAcceptedTracks<T extends AcceptedTrackAuthority>(
  acceptedTracks: T[],
  outstanding: OutstandingTrackAuthority[],
) {
  return acceptedTracks.filter((track) => !outstanding.some((row) => (
    Boolean(row.track_key) && row.track_key === track.track_key
    && (instantOrder(row.current_revision_created_at) > instantOrder(track.current_revision_created_at)
      || (instantOrder(row.current_revision_created_at) === instantOrder(track.current_revision_created_at) && row.id > track.id))
  )));
}
