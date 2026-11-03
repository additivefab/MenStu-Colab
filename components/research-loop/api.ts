// Client helpers and response shapes for the research-loop endpoints
// (docs/科研闭环_实施规格_v1.md §6). The shapes mirror the route/service
// files; authorization always comes from the server's `permissions` objects.

import type { BaselineCandidate, ResultInterpretationView, RunBaselineView } from "../../lib/research-loop/results-contract.ts";

export type TaskStatus = "draft" | "confirmed" | "closed" | "canceled";
export type TaskBudget = { maxAgentMinutes?: number; maxGpuCount?: number; maxWalltimeMinutes?: number };

export type TaskSummary = {
  id: string;
  studentId: string;
  title: string;
  status: TaskStatus;
  currentVersion: number;
  confirmedVersion: number | null;
  sourceGuidanceNoteId: number | null;
  sourceRunId: string | null;
  parentTaskId: string | null;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
};

export type TaskVersion = {
  version: number;
  title: string;
  researchQuestion: string;
  hypothesis: string;
  instructions: string;
  acceptanceCriteria: string;
  allowedPaths: string[];
  protectedPaths: string[];
  budget: TaskBudget;
  snapshotSha256: string;
  authorUserId: number;
  confirmedByUserId: number | null;
  confirmedAt: string | null;
  createdAt: string;
};

export type AttemptSummary = {
  id: string;
  taskVersion: number;
  provider: string;
  modelId: string;
  status: string;
  baseCommitSha: string;
  errorCode: string;
  errorMessage: string;
  requestedByUserId: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
};

export type TaskPermissions = {
  canRevise: boolean;
  canConfirm: boolean;
  canClose: boolean;
  canCancel: boolean;
  canStartAttempt: boolean;
  providers: string[];
};

export type TaskDetail = {
  task: TaskSummary;
  versions: TaskVersion[];
  events: { id: number; version: number; action: string; actorType: string; actorUserId: number | null; createdAt: string }[];
  attempts: AttemptSummary[];
  changeRequests: { id: string; attemptId: string; status: string }[];
  permissions: TaskPermissions;
};

export type AttemptEvent = { sequence: number; kind: string; payload: Record<string, unknown>; createdAt: string };

/** FB2 plan-first: awaiting_plan = the agent is still writing it; pending = waiting for a human. */
export type AttemptPlanDecision = "awaiting_plan" | "pending" | "approved" | "rejected";

export type AttemptPlan = {
  text: string;
  decision: AttemptPlanDecision;
  submittedAt: string | null;
  /** Decider's display name (or id, depending on the server). */
  decidedBy: string | number | null;
  decidedAt: string | null;
  note: string;
  /** Optimistic-lock version sent back as `expectedVersion` on decide_plan. */
  version: number;
};

export type AttemptDetail = {
  attempt: AttemptSummary & {
    changedPaths: string[];
    tests: { command?: string; exitCode?: number; summary?: string }[];
    usage: Record<string, unknown>;
    heartbeatAt: string | null;
    cancelRequestedAt: string | null;
  };
  events: AttemptEvent[];
  nextAfterSequence: number;
  // Batch 5 (FB2). Optional so the card still renders against a server that
  // does not return them yet. null = not a plan-first attempt.
  plan?: AttemptPlan | null;
  permissions?: { canDecidePlan?: boolean };
};

export type ChangeRequestPermissions = { canPublish: boolean; canApproveExtraReview: boolean; canReject: boolean };

export type ChangeRequest = {
  id: string;
  taskId: string;
  attemptId: string;
  baseCommitSha: string;
  branchName: string;
  headCommitSha: string | null;
  prNumber: number | null;
  prUrl: string;
  status: string;
  requiresExtraReview: boolean;
  extraReviewApprovedByUserId: number | null;
  extraReviewApprovedAt: string | null;
  provider: string;
  modelId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  permissions: ChangeRequestPermissions;
};

export type ChangeRequestDetail = {
  changeRequest: Omit<ChangeRequest, "permissions">;
  change: { paths: { path: string; action: string }[]; unifiedDiff: string; diffTruncated: boolean } | null;
  permissions: ChangeRequestPermissions;
};

export type ParamSpec = {
  type: "string" | "integer" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  enum?: (string | number | boolean)[];
  maxLength?: number;
};

export type EgressPolicy = {
  schema: "tanyan.egress/v1";
  allowedExtensions: string[];
  maxFileBytes: number;
  maxTotalBytes: number;
  allowImages: boolean;
  blockDatasetHashMatches: true;
};

export type Entrypoint = {
  id: string;
  studentId: string | null;
  githubRepositoryId: number;
  name: string;
  argv: string[];
  paramsSchema: Record<string, ParamSpec>;
  imageRef: string;
  evaluationProtocolSha256: string;
  active: boolean;
};

export type Dataset = {
  id: string;
  label: string;
  runnerId: string;
  manifestSha256: string;
  splitManifestSha256: string;
  egressPolicy: EgressPolicy | null;
  active: boolean;
};

export type RunSummary = {
  id: string;
  attempt: number;
  status: string;
  taskId: string;
  studentId: string;
  runSpecSha256: string;
  approvalId: string | null;
  submitTag: string;
  runnerId: string | null;
  exitCode: number | null;
  failureReason: string;
  cancelRequestedAt: string | null;
  createdByUserId: number;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  executedCommitSha: string;
  entrypointId: string;
  datasetVersionId: string;
  changeRequestId: string | null;
  technicalValidity: string | null;
  reviewState: string | null;
};

export type RunSpec = {
  taskId: string;
  taskVersion: number;
  taskSnapshotSha256: string;
  repository: { provider: "github"; repositoryId: number; fullName: string };
  executedCommitSha: string;
  changeRequestId: string | null;
  entrypoint: { id: string; argv: string[]; imageRef: string; params: Record<string, string | number | boolean> };
  dataset: { versionId: string; manifestSha256: string; splitManifestSha256: string; mount: string };
  evaluationProtocolSha256: string;
  resources: { gpuCount: number; walltimeMinutes: number; memoryGb: number };
  network: string;
  egress: EgressPolicy;
};

export type RunArtifact = {
  id: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  kind: string;
  egressDecision: "published" | "held" | "rejected";
  egressReason: string;
  downloadable: boolean;
};

export type RunDetail = {
  run: RunSummary;
  spec: RunSpec;
  approvals: { id: string; runId: string | null; approverName: string; note: string; approvedAt: string; revokedAt: string | null; current: boolean }[];
  events: { sequence: number; fromStatus: string; toStatus: string; actorType: string; payload: Record<string, unknown>; createdAt: string }[];
  artifacts: RunArtifact[];
  result: {
    manifestSha256: string;
    metrics: { split?: string; evaluationProtocolSha256?: string; values?: Record<string, number> } | null;
    metricsSourceArtifactId: string | null;
    technicalValidity: "valid" | "invalid" | "unknown";
    validityNotes: string;
    createdAt: string;
  } | null;
  review: {
    state: string;
    hypothesisOutcome: string;
    reviewerUserId: number | null;
    note: string;
    followupTaskId: string | null;
    version: number;
    updatedAt: string;
  } | null;
  comments: { id: number; authorName: string; parentCommentId: number | null; body: string; createdAt: string }[];
  // Batch 4 (lib/research-loop/results-contract.ts). Optional so the card
  // still renders against a server that does not return them yet.
  /** Comparison run chosen for this run; null = no baseline set. */
  baseline?: RunBaselineView | null;
  /** Runs this viewer may pick as baseline (only meaningful with canSetBaseline). */
  baselineCandidates?: BaselineCandidate[];
  /** Latest student interpretation; null = none yet. */
  interpretation?: ResultInterpretationView | null;
  /** Number of saved interpretation versions. */
  interpretationVersions?: number;
  permissions: {
    canApprove: boolean;
    canRevokeApproval: boolean;
    canCancel: boolean;
    canRerun: boolean;
    canReview: boolean;
    canComment: boolean;
    canSetBaseline?: boolean;
    canInterpret?: boolean;
    canDraftProgress?: boolean;
  };
};

export type RunList = { runs: RunSummary[]; options?: { entrypoints: Entrypoint[]; datasets: Dataset[] } };

/** Error carrying the server's Chinese message and machine code. */
export class LoopRequestError extends Error {
  code: string;
  status: number;
  payload: Record<string, unknown>;
  constructor(message: string, code: string, status: number, payload: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

async function parse<T>(response: Response, fallback: string): Promise<T> {
  let payload: Record<string, unknown> = {};
  try { payload = await response.json() as Record<string, unknown>; } catch { payload = {}; }
  if (!response.ok) {
    throw new LoopRequestError(typeof payload.error === "string" && payload.error ? payload.error : fallback,
      typeof payload.code === "string" ? payload.code : "", response.status, payload);
  }
  return payload as T;
}

export async function getJson<T>(url: string, fallback: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal });
  return parse<T>(response, fallback);
}

export async function postJson<T>(url: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parse<T>(response, fallback);
}

/** Idempotency/mutation key accepted by every research-loop endpoint (8–128 of [A-Za-z0-9_-]). */
export function newKey() {
  return crypto.randomUUID().replaceAll("-", "_");
}

export function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
