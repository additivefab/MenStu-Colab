type TrackContext = {
  proposal: { status: string; version: number } | null;
  papers: Array<{ id: number; status: string }>;
  milestones: Array<{ id: number; status: string }>;
};

export function isCurrentResearchTrack(
  track: { paperId?: number | null; milestoneId?: number | null; proposalVersion?: number | null },
  context: TrackContext,
) {
  if (track.paperId && !context.papers.some((paper) => paper.id === track.paperId && paper.status !== "closed")) return false;
  if (track.milestoneId) {
    return context.proposal?.status === "approved" && track.proposalVersion === context.proposal.version
      && context.milestones.some((milestone) => milestone.id === track.milestoneId && milestone.status !== "completed");
  }
  return true;
}
