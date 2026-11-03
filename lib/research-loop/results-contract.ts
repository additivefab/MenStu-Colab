// Batch 4 contract (frontend plan FA2–FA4): shapes shared by the run/result
// services and the UI. Erasable TypeScript only.
//
// Endpoints (existing routes, new actions/fields):
//   GET  /api/runs?runId=      RunDetail gains: baseline, baselineCandidates,
//                              interpretation, interpretationVersions, and
//                              permissions.canSetBaseline / canInterpret / canDraftProgress
//   POST /api/runs             { action: "set_baseline", runId, baselineRunId: string | null }
//                              → { runId, baseline: RunBaselineView | null }
//   POST /api/run-results      { action: "interpret", runId, requestId, expectedVersion, ...InterpretationInput }
//                              → { interpretation: ResultInterpretationView }
//   POST /api/run-results      { action: "progress_draft", runId } → { draft: ProgressDraft } (no write)
//   GET  /api/research-loop/evidence?studentId=&from=YYYY-MM-DD&to=YYYY-MM-DD → EvidenceReport
//
// Rules:
// - Baseline: a completed, technically valid run of the same student (any of
//   their tasks), never the run itself. Setting it does not touch the run spec
//   or its approval. Owner student or a reviewer in scope may set/clear it.
//   protocolMatches compares the evaluation protocol hashes of the two specs;
//   a mismatch is shown, never hidden (T21).
// - Interpretation: written only by the student who owns the run, after the run
//   is terminal (completed or failed). Versioned; expectedVersion is the latest
//   version the client saw (0 for none); idempotent by requestId. Review is
//   allowed without it — the UI warns.
// - Progress draft: owner student or reviewer in scope; built from the task,
//   run, metrics source, PR and latest interpretation; nothing is saved.
// - Evidence report: viewers in scope (canViewStudent); period ≤ 62 days.

export type RunBaselineView = {
  runId: string;
  taskId: string;
  taskTitle: string;
  /** Per-task run number of the baseline run, when computable. */
  number: number | null;
  executedCommitShort: string;
  metrics: { [name: string]: number } | null;
  evaluationProtocolSha256: string;
  protocolMatches: boolean;
  setByUserId: number;
  setAt: string;
};

export type BaselineCandidate = {
  runId: string;
  taskId: string;
  taskTitle: string;
  number: number | null;
  endedAt: string | null;
  protocolMatches: boolean;
};

export type InterpretationInput = {
  whatItShows: string;
  alternativeExplanations: string;
  limitations: string;
  proposedNextStep: string;
};

export type ResultInterpretationView = InterpretationInput & {
  version: number;
  authorUserId: number;
  authorName: string;
  createdAt: string;
};

export type ProgressDraftSource = { sourceType: "url" | "git"; label: string; ref: string };

export type ProgressDraft = {
  /** Existing progress kind used for project progress. */
  kind: "项目";
  title: string;
  summary: string;
  evidence: string;
  evidenceSources: ProgressDraftSource[];
  /** Ids the draft was built from, for traceability in the composer. */
  from: { taskId: string; runId: string; changeRequestId: string | null; interpretationVersion: number | null };
};

export type EvidenceReport = {
  studentId: string;
  period: { from: string; to: string };
  tasks: { taskId: string; title: string; status: string; versionsConfirmed: number; created: boolean }[];
  changeRequests: { id: string; taskId: string; prNumber: number | null; prUrl: string; status: string; createdAt: string }[];
  runs: {
    runId: string;
    taskId: string;
    number: number | null;
    status: string;
    technicalValidity: string | null;
    reviewState: string | null;
    endedAt: string | null;
    metrics: { [name: string]: number } | null;
    failureReason: string;
    interpreted: boolean;
  }[];
  /** Open items that block progress: failed runs, rejected/failed changes, unconfirmed drafts. */
  blockers: { kind: "run_failed" | "change_failed" | "task_unconfirmed"; text: string; taskId: string; runId: string | null }[];
};
