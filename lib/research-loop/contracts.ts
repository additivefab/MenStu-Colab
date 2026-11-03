// Shared research-loop contract (docs/科研闭环_实施规格_v1.md).
// Pure TypeScript with erasable syntax only and no runtime imports, so the
// Worker bundle and the lab Node processes (`node --experimental-strip-types`)
// load the same definitions.

export const AGENT_PROVIDERS = ["codex", "claude", "deepseek"] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];

export const TASK_STATUSES = ["draft", "confirmed", "closed", "canceled"] as const;
export type ResearchTaskStatus = typeof TASK_STATUSES[number];

export const AGENT_ATTEMPT_STATUSES = [
  "queued", "running", "waiting_approval", "change_ready", "failed", "cancel_requested", "canceled",
] as const;
export type AgentAttemptStatus = typeof AGENT_ATTEMPT_STATUSES[number];

export const CHANGE_REQUEST_STATUSES = [
  "pending_review", "publishing", "open", "merged", "closed", "rejected", "failed",
] as const;
export type ChangeRequestStatus = typeof CHANGE_REQUEST_STATUSES[number];

export const RUN_STATUSES = [
  "awaiting_approval", "queued", "dispatching", "running", "collecting",
  "completed", "failed", "cancel_requested", "canceled", "reconciling",
] as const;
export type RunStatus = typeof RUN_STATUSES[number];

export const REVIEW_STATES = ["pending", "accepted", "rejected", "needs_followup"] as const;
export type ReviewState = typeof REVIEW_STATES[number];

export const HYPOTHESIS_OUTCOMES = ["not_assessed", "supported", "not_supported", "inconclusive", "not_applicable"] as const;
export type HypothesisOutcome = typeof HYPOTHESIS_OUTCOMES[number];

export const ARTIFACT_KINDS = ["metrics", "figure", "table", "log", "model", "other"] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export const EGRESS_DECISIONS = ["published", "held", "rejected"] as const;
export type EgressDecision = typeof EGRESS_DECISIONS[number];

// Allowed state transitions. Services must reject anything not listed here.
// Terminal states have no outgoing edges; a re-run is a new run/attempt row.
export const AGENT_ATTEMPT_TRANSITIONS: Readonly<Record<AgentAttemptStatus, readonly AgentAttemptStatus[]>> = {
  queued: ["running", "cancel_requested", "canceled", "failed"],
  running: ["waiting_approval", "change_ready", "failed", "cancel_requested"],
  waiting_approval: ["running", "failed", "cancel_requested"],
  cancel_requested: ["canceled", "failed", "change_ready"],
  change_ready: [],
  failed: [],
  canceled: [],
};

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  awaiting_approval: ["queued", "canceled"],
  queued: ["dispatching", "cancel_requested", "canceled"],
  dispatching: ["running", "reconciling", "failed", "cancel_requested"],
  running: ["collecting", "failed", "reconciling", "cancel_requested"],
  collecting: ["completed", "failed", "reconciling"],
  // "dispatching" only after the runner proved no scheduler job carries submitTag.
  reconciling: ["dispatching", "running", "collecting", "failed", "cancel_requested", "canceled"],
  cancel_requested: ["canceled", "failed", "reconciling"],
  completed: [],
  failed: [],
  canceled: [],
};

export function canTransition<S extends string>(table: Readonly<Record<S, readonly S[]>>, from: S, to: S) {
  return table[from]?.includes(to) ?? false;
}

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "canceled"];
export const TERMINAL_ATTEMPT_STATUSES: readonly AgentAttemptStatus[] = ["change_ready", "failed", "canceled"];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIMITS = {
  leaseSeconds: 120,
  maxChangedFiles: 200,
  maxChangedFileBytes: 1_000_000,
  maxChangeTotalBytes: 5_000_000,
  maxDiffBytes: 2_000_000,
  maxAgentEventsPerRequest: 100,
  maxAgentEventPayloadBytes: 16_000,
  maxManifestBytes: 256_000,
  maxPublishedArtifactBytes: 10_000_000,
  maxInstructionChars: 20_000,
} as const;

export const DEFAULT_PROTECTED_PATHS = [
  ".github/**",
  ".gitlab-ci.yml",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "secrets/**",
  "eval_protocol/**",
  "evaluation/**",
  "data/splits/**",
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/**",
  ".codex/**",
  ".mcp.json",
  // Environment and dependency definitions change what runs on lab servers (T05).
  "**/requirements*.txt",
  "**/pyproject.toml",
  "**/setup.py",
  "**/setup.cfg",
  "**/Pipfile",
  "**/Pipfile.lock",
  "**/poetry.lock",
  "**/uv.lock",
  "**/environment*.yml",
  "**/environment*.yaml",
  "**/conda-lock*.yml",
  "**/Dockerfile*",
  "**/*.def",
  "**/package.json",
  "**/package-lock.json",
] as const;

// ---------------------------------------------------------------------------
// Canonical JSON and hashing (Web Crypto: Workers and Node 22+)
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace.
 * Rejects undefined, functions, non-finite numbers, and non-plain objects so a
 * hash can never silently cover a lossy serialization. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value as Record<string, unknown>).sort().map((key) => {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) throw new TypeError(`canonicalJson: undefined at key ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(item)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newId(prefix: "task" | "att" | "cr" | "run" | "apr" | "art" | "ep" | "ds" | "rnr" | "cred") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export const isCommitSha = (value: unknown): value is string => typeof value === "string" && SHA1_HEX.test(value);
export const isSha256 = (value: unknown): value is string => typeof value === "string" && SHA256_HEX.test(value);

// ---------------------------------------------------------------------------
// Research task snapshot
// ---------------------------------------------------------------------------

export type TaskBudget = {
  maxAgentMinutes?: number;
  maxGpuCount?: number;
  maxWalltimeMinutes?: number;
};

export type ResearchTaskSnapshot = {
  schema: "tanyan.task/v1";
  taskId: string;
  version: number;
  studentId: string;
  title: string;
  researchQuestion: string;
  hypothesis: string;
  instructions: string;
  acceptanceCriteria: string;
  allowedPaths: string[];
  protectedPaths: string[];
  budget: TaskBudget;
};

export async function taskSnapshotSha256(snapshot: ResearchTaskSnapshot) {
  return sha256Hex(canonicalJson(snapshot as unknown as JsonValue));
}

// ---------------------------------------------------------------------------
// Run spec: the immutable object an approval binds to (pack §5)
// ---------------------------------------------------------------------------

export type EgressPolicy = {
  schema: "tanyan.egress/v1";
  /** Lowercase extensions (".json", ".png", …) that may leave the lab. */
  allowedExtensions: string[];
  maxFileBytes: number;
  maxTotalBytes: number;
  /** Image outputs may depict raw data; publishing them needs this flag. */
  allowImages: boolean;
  /** Outputs whose sha256 matches any dataset manifest entry are always rejected. */
  blockDatasetHashMatches: true;
};

export type RunSpec = {
  schema: "tanyan.runspec/v1";
  taskId: string;
  taskVersion: number;
  taskSnapshotSha256: string;
  studentId: string;
  repository: { provider: "github"; repositoryId: number; fullName: string };
  executedCommitSha: string;
  changeRequestId: string | null;
  entrypoint: {
    id: string;
    argv: string[];
    imageRef: string;
    params: { [key: string]: string | number | boolean };
  };
  dataset: { versionId: string; manifestSha256: string; splitManifestSha256: string; mount: "read_only" };
  evaluationProtocolSha256: string;
  resources: { gpuCount: number; walltimeMinutes: number; memoryGb: number };
  network: "deny";
  egress: EgressPolicy;
};

export async function runSpecSha256(spec: RunSpec) {
  return sha256Hex(canonicalJson(spec as unknown as JsonValue));
}

// ---------------------------------------------------------------------------
// Repository path policy (pack §4: trusted publisher validates paths)
// ---------------------------------------------------------------------------

export class PathPolicyError extends Error {}

/** Normalizes a repository-relative POSIX path or throws. Rejects absolute
 * paths, traversal, backslashes, NUL/control characters, and `.git` internals. */
export function normalizeRepoPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024) throw new PathPolicyError("路径无效");
  if (value.includes("\\") || [...value].some((char) => char.charCodeAt(0) < 0x20)) {
    throw new PathPolicyError(`路径包含非法字符：${value}`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new PathPolicyError(`不允许绝对路径：${value}`);
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new PathPolicyError(`路径不规范：${value}`);
  // Case-insensitive: checkouts may land on case-insensitive filesystems.
  if (parts.some((part) => part.toLowerCase() === ".git")) throw new PathPolicyError(`不允许修改 .git：${value}`);
  return parts.join("/");
}

function globToRegExp(pattern: string, flags = "") {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const slash = pattern[index + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, flags);
}

export function matchesPathPattern(path: string, pattern: string, options: { caseInsensitive?: boolean } = {}) {
  return globToRegExp(pattern, options.caseInsensitive ? "i" : "").test(path);
}

export type PathPolicyResult = {
  paths: string[];
  outsideAllowed: string[];
  protectedTouched: string[];
};

/** Empty `allowed` means the whole repository except protected paths. */
export function evaluatePathPolicy(paths: unknown[], allowed: readonly string[], protectedPatterns: readonly string[]): PathPolicyResult {
  const normalized = [...new Set(paths.map(normalizeRepoPath))].sort();
  return {
    paths: normalized,
    outsideAllowed: allowed.length ? normalized.filter((path) => !allowed.some((pattern) => matchesPathPattern(path, pattern))) : [],
    // Protected matching errs toward review: case-insensitive. Allowed matching stays exact.
    protectedTouched: normalized.filter((path) => protectedPatterns.some((pattern) => matchesPathPattern(path, pattern, { caseInsensitive: true }))),
  };
}

// ---------------------------------------------------------------------------
// Metrics: only machine-produced files become formal metrics (pack §8)
// ---------------------------------------------------------------------------

export type MetricsFile = {
  schema: "tanyan.metrics/v1";
  evaluationProtocolSha256: string;
  split: string;
  values: { [name: string]: number };
};

export function validateMetricsFile(value: unknown): { ok: true; metrics: MetricsFile } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "metrics 不是对象" };
  const record = value as Record<string, unknown>;
  if (record.schema !== "tanyan.metrics/v1") return { ok: false, error: "metrics schema 不是 tanyan.metrics/v1" };
  if (!isSha256(record.evaluationProtocolSha256)) return { ok: false, error: "缺少评价协议 sha256" };
  if (typeof record.split !== "string" || !record.split || record.split.length > 64) return { ok: false, error: "split 无效" };
  const values = record.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, error: "values 不是对象" };
  const entries = Object.entries(values as Record<string, unknown>);
  if (!entries.length || entries.length > 200) return { ok: false, error: "values 数量需在 1–200 之间" };
  for (const [name, metric] of entries) {
    if (!/^[A-Za-z0-9_.@/-]{1,80}$/.test(name)) return { ok: false, error: `指标名无效：${name}` };
    if (typeof metric !== "number" || !Number.isFinite(metric)) return { ok: false, error: `指标值无效：${name}` };
  }
  return { ok: true, metrics: record as unknown as MetricsFile };
}

// ---------------------------------------------------------------------------
// Run manifest (pack templates/run_manifest.example.json, normalized)
// ---------------------------------------------------------------------------

export type ManifestArtifact = {
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  kind: ArtifactKind;
  egressDecision: EgressDecision;
  egressReason: string;
  /** Opaque locator on lab storage; never a download URL. */
  labLocator: string;
};

export type RunManifest = {
  schema: "tanyan.manifest/v1";
  runId: string;
  attempt: number;
  runSpecSha256: string;
  approvalId: string;
  repository: { repositoryId: number; executedCommitSha: string };
  inputs: { datasetVersionId: string; manifestSha256: string; splitManifestSha256: string; evaluationProtocolSha256: string; seeds: number[] };
  environment: { imageDigest: string; driverVersion: string; gpuModel: string };
  execution: {
    runnerId: string;
    schedulerJobId: string;
    submitTag: string;
    entrypointId: string;
    startedAt: string;
    endedAt: string;
    exitCode: number;
  };
  /** relativePath of the metrics artifact, or null when evaluation produced none. */
  metricsArtifactPath: string | null;
  artifacts: ManifestArtifact[];
};

// ---------------------------------------------------------------------------
// Lab protocol (platform ⇄ lab runner/worker). Transport: HTTPS POST JSON with
// `Authorization: Bearer <runner token>`; every request carries `action`.
// Endpoint for compute runners: POST /api/lab/runs
// Endpoint for agent workers:   POST /api/lab/agent-attempts
// Lease fencing: every mutating call after claim carries leaseEpoch; the
// platform answers 409 {code:"LEASE_LOST"} when it no longer matches.
// ---------------------------------------------------------------------------

export type RepositoryReadAccess = {
  fullName: string;
  repositoryId: number;
  /** Short-lived GitHub installation token, contents:read on this repo only. */
  token: string;
  expiresAt: string;
};

export type ComputeClaimRequest = { action: "claim" };
export type ComputeClaimResponse =
  | { work: null }
  | {
      work: {
        mode: "execute" | "reconcile";
        runId: string;
        attempt: number;
        submitTag: string;
        leaseEpoch: number;
        leaseExpiresAt: string;
        approvalId: string;
        runSpecSha256: string;
        spec: RunSpec;
        /** Minted read token for mode "execute". null in reconcile mode, or when
         * the platform has no GitHub App configured: the runner then uses its own
         * configured read-only access (deploy key or local mirror). */
        repository: RepositoryReadAccess | null;
        /** Scheduler job id already recorded, if any (reconcile mode). */
        schedulerJobId: string | null;
      };
    };

export type ComputeHeartbeatRequest = {
  action: "heartbeat";
  runId: string;
  leaseEpoch: number;
  phase: "dispatching" | "running" | "collecting";
  schedulerJobId?: string;
};
export type ComputeHeartbeatResponse = { leaseExpiresAt: string; cancelRequested: boolean };

/** Runner found (or did not find) a scheduler job carrying submitTag. */
export type ComputeReconcileRequest = {
  action: "reconcile";
  runId: string;
  leaseEpoch: number;
  found: boolean;
  schedulerJobId?: string;
  schedulerState?: "pending" | "running" | "finished" | "failed" | "canceled" | "unknown";
};

export type ComputeCompleteRequest = {
  action: "complete";
  runId: string;
  leaseEpoch: number;
  outcome: "completed" | "failed" | "canceled";
  exitCode: number | null;
  failureReason?: string;
  manifest: RunManifest | null;
  /** Inline content (base64) of published small artifacts, keyed by relativePath. */
  publishedFiles?: { relativePath: string; contentBase64: string }[];
};

export type AgentClaimRequest = { action: "claim" };
export type AgentClaimResponse =
  | { work: null }
  | {
      work: {
        attemptId: string;
        leaseEpoch: number;
        leaseExpiresAt: string;
        provider: AgentProvider;
        modelId: string;
        /** Opaque profile id; the worker maps it to a local credential dir. */
        credentialProfileId: string;
        baseCommitSha: string;
        task: ResearchTaskSnapshot;
        contextSnapshotSha256: string;
        /** null when the platform has no GitHub App configured; the worker then
         * uses its own configured read-only access. */
        repository: RepositoryReadAccess | null;
        repositoryId: number;
        repositoryFullName: string;
      };
    };

export type AgentEvent = {
  sequence: number;
  kind: "status" | "message" | "tool_call" | "tool_result" | "file_change" | "test" | "usage" | "error";
  /** Sanitized, size-capped; never secrets or raw dataset content. */
  payload: { [key: string]: JsonValue };
};

export type AgentEventsRequest = { action: "events"; attemptId: string; leaseEpoch: number; events: AgentEvent[] };
export type AgentHeartbeatRequest = { action: "heartbeat"; attemptId: string; leaseEpoch: number };
export type AgentHeartbeatResponse = { leaseExpiresAt: string; cancelRequested: boolean };

export type ChangedFile = {
  path: string;
  action: "add" | "modify" | "delete";
  /** Absent for delete. */
  contentBase64?: string;
  sha256?: string;
  /** Git file mode; executables keep 100755. */
  mode?: "100644" | "100755";
};

export type AgentTestRecord = { command: string; exitCode: number; summary: string };

export type AgentResultRequest = {
  action: "result";
  attemptId: string;
  leaseEpoch: number;
  outcome: "change_ready" | "failed" | "canceled";
  modelId: string;
  sdkVersion: string;
  files: ChangedFile[];
  unifiedDiff: string;
  tests: AgentTestRecord[];
  usage: { [key: string]: JsonValue };
  errorCode?: string;
  errorMessage?: string;
};

export type AdapterCapabilities = {
  provider: AgentProvider;
  streaming: boolean;
  cancel: boolean;
  resume: boolean;
  toolApproval: boolean;
  structuredResult: boolean;
  usage: boolean;
};
