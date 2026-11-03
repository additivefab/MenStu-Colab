// Compensating reconciliation for the research loop (G2; design pack 02 §6
// "至少一次事件处理、幂等副作用和补偿对账" and §7 "Webhook 丢失… 通过定时对账
// 恢复最终一致"). External events (runner heartbeats, agent-worker results,
// GitHub webhooks, Feishu deliveries) can be lost; this sweep makes sure the
// loop never stays stuck because of that.
//
// Every step is idempotent: each write is guarded by the exact state that was
// read (status, lease epoch, lease expiry, heartbeat, version), so a second run,
// a concurrent runner call or a concurrent manual trigger turns it into a no-op.
// Every change writes the audit row the owning service writes for that object:
// `run_events` (actor_type 'system', actor_id 'maintenance'), platform entries
// in `agent_attempt_events` (negative sequence, `source: "platform"`), and a
// `github_webhook_deliveries` row (delivery id `maintenance:<cr>:v<version>`)
// for change requests, which only the webhook updates otherwise.
//
// Rules and thresholds (THRESHOLDS below):
// 1. Runs in `cancel_requested` whose lease has lapsed (or never existed) and
//    whose runner has not been heard from for 30 min → `canceled`, reason
//    "执行器长时间未响应，平台收尾取消". A valid lease is never touched.
// 2. Runs in dispatching/running/collecting/reconciling with a lapsed lease and
//    no runner contact for 24 h are only REPORTED (`runs.staleAttention`).
//    Decision: reconciling is the runner's job (pack §6.4: query the scheduler
//    by submit tag, never resubmit blindly). The GPU job may still be running
//    or have finished with results the runner has not uploaded yet, and
//    `claimRun` moves such a run to `reconciling` as soon as its runner returns.
//    Failing it here would orphan scheduler jobs and discard results, so it
//    happens only with the explicit `finalizeStaleRuns` flag (superadmin
//    endpoint only), and then as `failed` with an explanatory reason.
// 3. Agent attempts: `running` with a lapsed lease → `failed` / LEASE_EXPIRED
//    (the rule `expireAgentLeases` applies lazily, same message).
//    `cancel_requested` with a lapsed or absent lease and no worker contact for
//    30 min → `canceled`. `waiting_approval` is never touched (a human decides).
// 4. Change requests (only with the GitHub App configured): `open` and
//    `publishing` rows not updated for 10 min are refreshed from the GitHub API
//    with the webhook's mapping: merged → `merged`, closed → `closed` (from open
//    or publishing), head SHA follows the PR for `open` rows. The PR's head ref
//    must equal the stored branch (webhook rule). A `publishing` row whose PR is
//    open or absent is left for re-publish (claimPublish accepts `publishing`)
//    and reported as stuck after 15 min. Without the App the step is skipped.
// 5. Notifications (only with Feishu configured): `failed` rows with attempts
//    < 3 created within 24 h are retried through the existing sender, only
//    while the event is still waiting for that recipient.
//
// Dry run computes the same candidate lists without writing and without any
// outbound call. Work per invocation is bounded (BATCH) to stay inside Worker
// subrequest limits; the next run picks up the rest.
//
// Scheduling (see worker/index.ts):
// - Cloudflare cron trigger → Worker `scheduled()` → runLoopMaintenance. The
//   build writes dist/server/wrangler.json from `localBindingConfig` in
//   vite.config.ts (currently `"triggers": {}`); a self-managed Wrangler deploy
//   enables the sweep with `triggers: { crons: ["*/10 * * * *"] }` there. The
//   hosted Sites deployment (.openai/hosting.json: project id + D1/R2 binding
//   names only) documents no trigger setting, so do not rely on the cron there.
// - Fallback that works on any host: a cron entry on the lab runner host calls
//   POST /api/admin/maintenance {"action":"run"} with the compute runner's
//   bearer token (the same token as /api/lab/runs). Runner calls may not
//   finalize stale runs, receive counts only (no ids) and are throttled.
//   Example: */10 * * * * curl -fsS -X POST -H "Authorization: Bearer $TOKEN"
//     -H 'content-type: application/json' -d '{"action":"run"}' https://<site>/api/admin/maintenance
// - Superadmins can run or dry-run it from the same endpoint (session, same origin).
import { isFeishuConfigured } from "./feishu-auth";
import { GithubApiError, encodePathSegments, githubRequest } from "./github/http";
import { GithubNotConfiguredError, isGithubAppConfigured, mintSingleRepositoryToken } from "./github/tokens";
import { retryLoopNotification } from "./loop-notifications";
import {
  AGENT_ATTEMPT_TRANSITIONS, RUN_TRANSITIONS, canTransition, canonicalJson, sha256Hex,
  type AgentAttemptStatus, type JsonValue, type RunStatus,
} from "./research-loop/contracts";

const MINUTE = 60_000;

export const THRESHOLDS = {
  /** Runs/attempts in cancel_requested without runner/worker contact. */
  cancelUnresponsiveMs: 30 * MINUTE,
  /** In-flight runs with a lapsed lease and no runner contact (attention). */
  staleRunMs: 24 * 60 * MINUTE,
  /** Change requests not updated for this long are refreshed from GitHub. */
  changeRequestRefreshMs: 10 * MINUTE,
  /** A `publishing` change request older than this is reported as stuck. */
  publishingStuckMs: 15 * MINUTE,
  /** Failed notifications are retried while younger than this … */
  notificationMaxAgeMs: 24 * 60 * MINUTE,
  /** … and while fewer delivery attempts were made. */
  notificationMaxAttempts: 3,
} as const;

/** Upper bound of items handled per step and invocation. */
export const BATCH = { runs: 50, attempts: 50, changeRequests: 20, notifications: 10 } as const;

export const RUN_CANCEL_REASON = "执行器长时间未响应，平台收尾取消";
export const RUN_STALE_FAILURE_REASON = "执行器超过 24 小时未联系，平台按失败收尾（未确认调度器作业状态）";
const ATTEMPT_LEASE_MESSAGE = "代理工作进程租约过期，未自动重派；如需继续请新建尝试";
const ATTEMPT_CANCEL_MESSAGE = "代理工作进程长时间未响应，平台收尾取消";
const ACTOR_ID = "maintenance";
const IN_FLIGHT: readonly RunStatus[] = ["dispatching", "running", "collecting", "reconciling"];

export type MaintenanceEnv = {
  /** Optional public site origin for notification links when no request is in scope (cron). */
  PUBLIC_SITE_ORIGIN?: string;
};

export type MaintenanceOptions = {
  now?: Date;
  dryRun?: boolean;
  /** Step 2: fail stale in-flight runs instead of only reporting them. */
  finalizeStaleRuns?: boolean;
  /** Site origin for notification deep links (null = card without link). */
  origin?: string | null;
};

export type ItemList = { count: number; ids: string[] };

export type MaintenanceReport = {
  dryRun: boolean;
  now: string;
  thresholdsMinutes: Record<string, number>;
  runs: { cancelFinalized: ItemList; staleAttention: ItemList; staleFinalized: ItemList; finalizeAllowed: boolean };
  agentAttempts: { leaseExpiredFailed: ItemList; cancelFinalized: ItemList };
  changeRequests: {
    skipped: "github_not_configured" | null;
    checked: ItemList;
    merged: ItemList;
    closed: ItemList;
    headUpdated: ItemList;
    publishingStuck: ItemList;
    unlinked: ItemList;
    failed: ItemList;
  };
  notifications: { skipped: "feishu_not_configured" | null; candidates: ItemList; sent: ItemList; failed: ItemList; stale: ItemList };
  errors: { step: string; message: string }[];
};

const list = (): ItemList => ({ count: 0, ids: [] });
function push(target: ItemList, id: string) {
  target.ids.push(id);
  target.count = target.ids.length;
}

function emptyReport(now: Date, dryRun: boolean, finalizeAllowed: boolean): MaintenanceReport {
  return {
    dryRun,
    now: now.toISOString(),
    thresholdsMinutes: Object.fromEntries(Object.entries(THRESHOLDS)
      .filter(([key]) => key.endsWith("Ms"))
      .map(([key, value]) => [key.replace(/Ms$/, ""), value / MINUTE])),
    runs: { cancelFinalized: list(), staleAttention: list(), staleFinalized: list(), finalizeAllowed },
    agentAttempts: { leaseExpiredFailed: list(), cancelFinalized: list() },
    changeRequests: {
      skipped: null, checked: list(), merged: list(), closed: list(), headUpdated: list(),
      publishingStuck: list(), unlinked: list(), failed: list(),
    },
    notifications: { skipped: null, candidates: list(), sent: list(), failed: list(), stale: list() },
    errors: [],
  };
}

/** Short, secret-free error text for the report. */
function errorText(error: unknown) {
  if (error instanceof GithubApiError) return error.message;
  if (error instanceof GithubNotConfiguredError) return "GitHub App 配置无效";
  const message = error instanceof Error ? error.message : String(error);
  return (message || "未知错误").replace(/\s+/g, " ").slice(0, 160);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Removes ids from a report (counts stay). Used for lab-runner callers. */
export function redactReportIds(report: MaintenanceReport): MaintenanceReport {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "ids" ? [] : strip(item)]));
    }
    return value;
  };
  return strip(report) as MaintenanceReport;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runLoopMaintenance(d1: D1Database, env: MaintenanceEnv, options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const report = emptyReport(now, dryRun, options.finalizeStaleRuns === true);
  const origin = options.origin !== undefined ? options.origin : publicOrigin(env.PUBLIC_SITE_ORIGIN);
  const steps: [string, () => Promise<void>][] = [
    ["runs_cancel", () => sweepCanceledRuns(d1, now, dryRun, report)],
    ["runs_stale", () => sweepStaleRuns(d1, now, dryRun, options.finalizeStaleRuns === true, report)],
    ["agent_attempts", () => sweepAttempts(d1, now, dryRun, report)],
    ["change_requests", () => refreshChangeRequests(d1, now, dryRun, report)],
    ["notifications", () => retryNotifications(d1, now, dryRun, origin, report)],
  ];
  // One failing step never blocks the others; it is reported and retried next run.
  for (const [step, run] of steps) {
    try { await run(); } catch (error) { report.errors.push({ step, message: errorText(error) }); }
  }
  return report;
}

function publicOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Runs (steps 1 and 2)
// ---------------------------------------------------------------------------

type RunCandidate = {
  id: string;
  status: RunStatus;
  lease_epoch: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  updated_at: string;
  last_contact: string | null;
};

/** Guarded system transition of one run: event row + UPDATE in one batch. The
 * guard is the exact row state that was read, including lease expiry and the
 * last heartbeat, so any runner contact in between turns it into a no-op. */
async function transitionRun(d1: D1Database, run: RunCandidate, to: RunStatus, nowIso: string, payload: Record<string, JsonValue>, reason: string) {
  if (!canTransition(RUN_TRANSITIONS, run.status, to)) return false;
  const guardSql = `EXISTS (SELECT 1 FROM runs WHERE id = ? AND status = ? AND lease_epoch = ?
    AND heartbeat_at IS ? AND (lease_expires_at IS NULL OR julianday(lease_expires_at) < julianday(?)))`;
  const guard = [run.id, run.status, run.lease_epoch, run.heartbeat_at, nowIso];
  const results = await d1.batch([
    d1.prepare(`INSERT INTO run_events (run_id, sequence, from_status, to_status, actor_type, actor_id, payload_json)
      SELECT ?, COALESCE((SELECT MAX(sequence) FROM run_events WHERE run_id = ?), 0) + 1, ?, ?, 'system', ?, ?
      WHERE ${guardSql}`)
      .bind(run.id, run.id, run.status, to, ACTOR_ID, JSON.stringify(payload), ...guard),
    d1.prepare(`UPDATE runs SET status = ?, failure_reason = ?, ended_at = ?, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = ? AND lease_epoch = ? AND heartbeat_at IS ?
        AND (lease_expires_at IS NULL OR julianday(lease_expires_at) < julianday(?))`)
      .bind(to, reason, nowIso, ...guard),
  ]);
  return (results[1]?.meta?.changes ?? 0) === 1;
}

const LAPSED_LEASE = "(lease_expires_at IS NULL OR julianday(lease_expires_at) < julianday(?))";

async function sweepCanceledRuns(d1: D1Database, now: Date, dryRun: boolean, report: MaintenanceReport) {
  const nowIso = now.toISOString();
  const cutoff = iso(now.getTime() - THRESHOLDS.cancelUnresponsiveMs);
  const { results } = await d1.prepare(`SELECT id, status, lease_epoch, lease_expires_at, heartbeat_at, updated_at,
      COALESCE(heartbeat_at, cancel_requested_at, updated_at) AS last_contact
    FROM runs WHERE status = 'cancel_requested' AND ${LAPSED_LEASE}
      AND julianday(COALESCE(heartbeat_at, cancel_requested_at, updated_at)) < julianday(?)
    ORDER BY id LIMIT ${BATCH.runs}`).bind(nowIso, cutoff).all<RunCandidate>();
  for (const run of results) {
    if (dryRun) { push(report.runs.cancelFinalized, run.id); continue; }
    const ok = await transitionRun(d1, run, "canceled", nowIso, {
      action: "maintenance_cancel", reason: RUN_CANCEL_REASON, lastContactAt: run.last_contact, leaseEpoch: run.lease_epoch,
    }, RUN_CANCEL_REASON);
    if (ok) push(report.runs.cancelFinalized, run.id);
  }
}

async function sweepStaleRuns(d1: D1Database, now: Date, dryRun: boolean, finalize: boolean, report: MaintenanceReport) {
  const nowIso = now.toISOString();
  const cutoff = iso(now.getTime() - THRESHOLDS.staleRunMs);
  const { results } = await d1.prepare(`SELECT id, status, lease_epoch, lease_expires_at, heartbeat_at, updated_at,
      COALESCE(heartbeat_at, started_at, updated_at) AS last_contact
    FROM runs WHERE status IN (${IN_FLIGHT.map(() => "?").join(", ")}) AND ${LAPSED_LEASE}
      AND julianday(COALESCE(heartbeat_at, started_at, updated_at)) < julianday(?)
    ORDER BY id LIMIT ${BATCH.runs}`).bind(...IN_FLIGHT, nowIso, cutoff).all<RunCandidate>();
  for (const run of results) {
    push(report.runs.staleAttention, run.id);
    if (!finalize) continue;
    if (dryRun) { push(report.runs.staleFinalized, run.id); continue; }
    const ok = await transitionRun(d1, run, "failed", nowIso, {
      action: "maintenance_stale_failed", reason: RUN_STALE_FAILURE_REASON, lastContactAt: run.last_contact,
      previousStatus: run.status, leaseEpoch: run.lease_epoch,
    }, RUN_STALE_FAILURE_REASON);
    if (ok) push(report.runs.staleFinalized, run.id);
  }
}

// ---------------------------------------------------------------------------
// Agent attempts (step 3)
// ---------------------------------------------------------------------------

type AttemptCandidate = {
  id: string;
  status: AgentAttemptStatus;
  lease_epoch: number;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
};

/** Same audit entry shape as the service's platform entries (negative sequence). */
function attemptAudit(d1: D1Database, attemptId: string, payload: Record<string, string | number | null>, guardSql: string, guard: unknown[]) {
  return d1.prepare(`INSERT INTO agent_attempt_events (attempt_id, sequence, kind, payload_json)
    SELECT ?, COALESCE((SELECT MIN(sequence) FROM agent_attempt_events WHERE attempt_id = ? AND sequence < 0), 0) - 1, 'status', ?
    WHERE ${guardSql}`)
    .bind(attemptId, attemptId, JSON.stringify({ source: "platform", actor: "system", by: ACTOR_ID, ...payload }), ...guard);
}

async function sweepAttempts(d1: D1Database, now: Date, dryRun: boolean, report: MaintenanceReport) {
  const nowIso = now.toISOString();
  const rowGuard = "id = ? AND status = ? AND lease_epoch = ? AND lease_expires_at IS ? AND heartbeat_at IS ?";
  const guardOf = (row: AttemptCandidate) => [row.id, row.status, row.lease_epoch, row.lease_expires_at, row.heartbeat_at];

  // 3a. Running with a lapsed lease → failed LEASE_EXPIRED (never re-dispatched).
  const expired = await d1.prepare(`SELECT id, status, lease_epoch, lease_expires_at, heartbeat_at FROM agent_attempts
    WHERE status = 'running' AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at) < julianday(?)
    ORDER BY id LIMIT ${BATCH.attempts}`).bind(nowIso).all<AttemptCandidate>();
  for (const row of expired.results) {
    if (!canTransition(AGENT_ATTEMPT_TRANSITIONS, row.status, "failed")) continue;
    if (dryRun) { push(report.agentAttempts.leaseExpiredFailed, row.id); continue; }
    const results = await d1.batch([
      attemptAudit(d1, row.id, { action: "lease_expired", from: row.status, to: "failed", leaseEpoch: row.lease_epoch },
        `EXISTS (SELECT 1 FROM agent_attempts WHERE ${rowGuard})`, guardOf(row)),
      d1.prepare(`UPDATE agent_attempts SET status = 'failed', error_code = 'LEASE_EXPIRED', error_message = ?,
          ended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE ${rowGuard}`)
        .bind(ATTEMPT_LEASE_MESSAGE, nowIso, ...guardOf(row)),
    ]);
    if ((results[1]?.meta?.changes ?? 0) === 1) push(report.agentAttempts.leaseExpiredFailed, row.id);
  }

  // 3b. Cancel requested, no worker holds a valid lease and none was heard from
  // for the threshold → canceled. waiting_approval is never selected.
  const cutoff = iso(now.getTime() - THRESHOLDS.cancelUnresponsiveMs);
  const canceled = await d1.prepare(`SELECT id, status, lease_epoch, lease_expires_at, heartbeat_at FROM agent_attempts
    WHERE status = 'cancel_requested' AND ${LAPSED_LEASE}
      AND julianday(COALESCE(heartbeat_at, cancel_requested_at, updated_at)) < julianday(?)
    ORDER BY id LIMIT ${BATCH.attempts}`).bind(nowIso, cutoff).all<AttemptCandidate>();
  for (const row of canceled.results) {
    if (!canTransition(AGENT_ATTEMPT_TRANSITIONS, row.status, "canceled")) continue;
    if (dryRun) { push(report.agentAttempts.cancelFinalized, row.id); continue; }
    const code = row.lease_expires_at ? "LEASE_EXPIRED" : "CANCELED";
    const results = await d1.batch([
      attemptAudit(d1, row.id, { action: "cancel_finalized", from: row.status, to: "canceled", leaseEpoch: row.lease_epoch },
        `EXISTS (SELECT 1 FROM agent_attempts WHERE ${rowGuard} AND ${LAPSED_LEASE})`, [...guardOf(row), nowIso]),
      d1.prepare(`UPDATE agent_attempts SET status = 'canceled',
          error_code = CASE WHEN error_code = '' THEN ? ELSE error_code END,
          error_message = CASE WHEN error_message = '' THEN ? ELSE error_message END,
          ended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE ${rowGuard} AND ${LAPSED_LEASE}`)
        .bind(code, ATTEMPT_CANCEL_MESSAGE, nowIso, ...guardOf(row), nowIso),
    ]);
    if ((results[1]?.meta?.changes ?? 0) === 1) push(report.agentAttempts.cancelFinalized, row.id);
  }
}

// ---------------------------------------------------------------------------
// Change requests (step 4)
// ---------------------------------------------------------------------------

type ChangeRequestCandidate = {
  id: string;
  status: "open" | "publishing";
  version: number;
  branch_name: string;
  head_commit_sha: string | null;
  pr_number: number | null;
  github_repository_id: number;
  updated_at: string;
  installation_id: number | null;
  full_name: string | null;
};

type PullRequest = { number?: unknown; state?: unknown; merged?: unknown; merged_at?: unknown; head?: { ref?: unknown; sha?: unknown } };

async function refreshChangeRequests(d1: D1Database, now: Date, dryRun: boolean, report: MaintenanceReport) {
  const section = report.changeRequests;
  const refreshCutoff = iso(now.getTime() - THRESHOLDS.changeRequestRefreshMs);
  const stuckCutoff = iso(now.getTime() - THRESHOLDS.publishingStuckMs);
  const stuckIds = async () => (await d1.prepare(`SELECT id FROM change_requests
      WHERE status = 'publishing' AND julianday(updated_at) < julianday(?) ORDER BY id LIMIT ${BATCH.changeRequests * 5}`)
    .bind(stuckCutoff).all<{ id: string }>()).results.map((row) => row.id);

  if (!isGithubAppConfigured()) {
    section.skipped = "github_not_configured";
    for (const id of await stuckIds()) push(section.publishingStuck, id);
    return;
  }

  // Oldest first among rows not touched recently; an unchanged row keeps its
  // updated_at, so RANDOM() breaks ties to avoid starving the rest of the batch.
  const { results } = await d1.prepare(`SELECT cr.id, cr.status, cr.version, cr.branch_name, cr.head_commit_sha, cr.pr_number,
      cr.github_repository_id, cr.updated_at, rl.installation_id, rl.full_name
    FROM change_requests cr
    LEFT JOIN repository_links rl ON rl.student_id = cr.student_id AND rl.github_repository_id = cr.github_repository_id
      AND rl.status = 'active'
      AND EXISTS (SELECT 1 FROM github_installations gi WHERE gi.installation_id = rl.installation_id AND gi.status = 'active')
    WHERE cr.status IN ('open', 'publishing') AND julianday(cr.updated_at) < julianday(?)
    ORDER BY RANDOM() LIMIT ${BATCH.changeRequests}`).bind(refreshCutoff).all<ChangeRequestCandidate>();
  results.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const tokens = new Map<string, Promise<{ token: string; fullName: string }>>();
  const tokenFor = (row: ChangeRequestCandidate) => {
    const key = `${row.installation_id}:${row.github_repository_id}`;
    let entry = tokens.get(key);
    if (!entry) {
      entry = mintSingleRepositoryToken({
        installationId: Number(row.installation_id), repositoryId: Number(row.github_repository_id), permissions: { pull_requests: "read" },
      }).then((minted) => ({ token: minted.token, fullName: minted.repositories[0].fullName || String(row.full_name) }));
      entry.catch(() => undefined);
      tokens.set(key, entry);
    }
    return entry;
  };

  for (const row of results) {
    if (row.installation_id === null || !row.full_name) { push(section.unlinked, row.id); continue; }
    push(section.checked, row.id);
    if (dryRun) continue;
    try {
      const access = await tokenFor(row);
      const pull = await findPull(access, row);
      if (!pull || str(pull.head?.ref) !== row.branch_name) continue; // absent or branch mismatch: change nothing
      const number = positive(pull.number);
      const headSha = /^[0-9a-f]{40}$/.test(str(pull.head?.sha).toLowerCase()) ? str(pull.head?.sha).toLowerCase() : null;
      const merged = pull.merged === true || (typeof pull.merged_at === "string" && pull.merged_at !== "");
      if (merged || pull.state === "closed") {
        const to = merged ? "merged" : "closed";
        if (await applyChangeRequest(d1, row, { to, number, headSha })) push(merged ? section.merged : section.closed, row.id);
      } else if (row.status === "open" && headSha && headSha !== row.head_commit_sha) {
        if (await applyChangeRequest(d1, row, { to: null, number, headSha })) push(section.headUpdated, row.id);
      }
    } catch (error) {
      push(section.failed, row.id);
      if (section.failed.count === 1) report.errors.push({ step: "change_requests", message: errorText(error) });
    }
  }

  // Stuck publishes are left for re-publish (claimPublish accepts `publishing`).
  for (const id of await stuckIds()) push(section.publishingStuck, id);
}

const str = (value: unknown, max = 255) => (typeof value === "string" ? value.slice(0, max) : "");
const positive = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

async function findPull(access: { token: string; fullName: string }, row: ChangeRequestCandidate): Promise<PullRequest | null> {
  const repo = `/repos/${encodePathSegments(access.fullName)}`;
  if (row.pr_number) {
    const { data } = await githubRequest<PullRequest>(`${repo}/pulls/${Number(row.pr_number)}`, {
      bearer: access.token, context: "对账查询 PR", allowStatuses: [404],
    });
    return data;
  }
  const [owner] = access.fullName.split("/");
  const { data } = await githubRequest<PullRequest[]>(
    `${repo}/pulls?state=all&per_page=20&head=${encodeURIComponent(`${owner}:${row.branch_name}`)}`,
    { bearer: access.token, context: "对账查询 PR" },
  );
  return (data ?? []).find((pull) => str(pull.head?.ref) === row.branch_name) ?? null;
}

/** Webhook mapping, guarded by the version that was read, with a delivery row
 * as audit (`maintenance:<id>:v<version>` is unique, so a replay adds nothing). */
async function applyChangeRequest(d1: D1Database, row: ChangeRequestCandidate,
  change: { to: "merged" | "closed" | null; number: number | null; headSha: string | null }) {
  const summary = {
    source: "maintenance", changeRequestId: row.id, fromStatus: row.status, toStatus: change.to ?? row.status,
    prNumber: change.number ?? row.pr_number, headSha: change.headSha, previousVersion: Number(row.version),
  };
  // Exact state that was read; head-only updates apply to `open` rows only.
  const guardSql = "EXISTS (SELECT 1 FROM change_requests WHERE id = ? AND status = ? AND version = ?)";
  const guard = [row.id, row.status, row.version];
  const update = change.to
    ? d1.prepare(`UPDATE change_requests SET status = ?, pr_number = COALESCE(pr_number, ?),
        head_commit_sha = COALESCE(?, head_commit_sha), version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ? AND version = ?`)
      .bind(change.to, change.number, change.headSha, ...guard)
    : d1.prepare(`UPDATE change_requests SET head_commit_sha = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ? AND version = ? AND status = 'open' AND (head_commit_sha IS NULL OR head_commit_sha <> ?)`)
      .bind(change.headSha, ...guard, change.headSha);
  const summaryJson = canonicalJson(summary as unknown as JsonValue);
  const results = await d1.batch([
    d1.prepare(`INSERT INTO github_webhook_deliveries
        (delivery_id, event, action, installation_id, repository_id, payload_sha256, summary_json, origin, status, processed_at)
        SELECT ?, 'pull_request', ?, ?, ?, ?, ?, 'external', 'processed', CURRENT_TIMESTAMP WHERE ${guardSql}
        ON CONFLICT(delivery_id) DO NOTHING`)
      .bind(`maintenance:${row.id}:v${Number(row.version)}`, change.to ? `reconcile_${change.to}` : "reconcile_synchronize",
        row.installation_id, row.github_repository_id, await sha256Hex(summaryJson), summaryJson, ...guard),
    update,
  ]);
  return (results[1]?.meta?.changes ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Notifications (step 5)
// ---------------------------------------------------------------------------

async function retryNotifications(d1: D1Database, now: Date, dryRun: boolean, origin: string | null, report: MaintenanceReport) {
  const section = report.notifications;
  if (!isFeishuConfigured()) { section.skipped = "feishu_not_configured"; return; }
  const cutoff = iso(now.getTime() - THRESHOLDS.notificationMaxAgeMs);
  const { results } = await d1.prepare(`SELECT event_key, recipient_user_id, channel FROM loop_notifications
    WHERE status = 'failed' AND attempts < ? AND julianday(created_at) > julianday(?)
    ORDER BY created_at, event_key, recipient_user_id LIMIT ${BATCH.notifications}`)
    .bind(THRESHOLDS.notificationMaxAttempts, cutoff).all<{ event_key: string; recipient_user_id: number; channel: string }>();
  for (const row of results) {
    const id = `${row.event_key}#${Number(row.recipient_user_id)}`;
    push(section.candidates, id);
    if (dryRun) continue;
    const outcome = await retryLoopNotification(d1, {
      eventKey: row.event_key, recipientUserId: Number(row.recipient_user_id), channel: row.channel,
    }, { origin, maxAttempts: THRESHOLDS.notificationMaxAttempts });
    if (outcome === "sent") push(section.sent, id);
    else if (outcome === "failed") push(section.failed, id);
    else if (outcome === "stale") push(section.stale, id);
  }
}
