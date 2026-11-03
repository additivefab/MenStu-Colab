// GitHub webhook receiver (spec §6.2, pack §7).
// Order: size cap → HMAC over the raw body (constant time) → delivery-ID
// dedupe → minimal processing. Only a small summary is stored, never the full
// payload. Events whose installation or repository disagrees with the
// server-side link are isolated as `ignored` and change nothing.
// Docs: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
import { sha256Hex } from "../research-loop/contracts.ts";
import { PLATFORM_ORIGIN_MARKER } from "./publisher.ts";

export const MAX_WEBHOOK_BYTES = 2_000_000;
const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** HMAC-SHA256 check of `X-Hub-Signature-256`. Web Crypto `verify` compares
 * in constant time, so no early-exit string comparison touches the secret. */
export async function verifyWebhookSignature(secret: string, body: Uint8Array<ArrayBuffer>, header: string | null) {
  if (!header || !header.startsWith("sha256=")) return false;
  const hex = header.slice("sha256=".length);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, hexToBytes(hex), body);
}

type Payload = {
  action?: unknown;
  installation?: { id?: unknown; app_id?: unknown; account?: { login?: unknown; type?: unknown }; repository_selection?: unknown };
  repository?: { id?: unknown };
  sender?: { login?: unknown; type?: unknown };
  repositories_removed?: { id?: unknown }[];
  repository_selection?: unknown;
  number?: unknown;
  pull_request?: { number?: unknown; merged?: unknown; body?: unknown; head?: { ref?: unknown; sha?: unknown } };
};

type Outcome = {
  status: "processed" | "ignored";
  origin: "external" | "platform_echo";
  reason: string;
  summary: Record<string, string | number | boolean | number[] | null>;
};

const int = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);
const str = (value: unknown, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");

export type WebhookContext = { appId: string | null; appSlug: string | null };

export type WebhookResult = { httpStatus: number; body: Record<string, unknown> };

export async function receiveGithubWebhook(d1: D1Database, request: Request, secret: string | null, context: WebhookContext): Promise<WebhookResult> {
  if (!secret) return { httpStatus: 503, body: { error: "GitHub Webhook 尚未配置" } };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BYTES) return { httpStatus: 413, body: { error: "事件内容过大" } };
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length > MAX_WEBHOOK_BYTES) return { httpStatus: 413, body: { error: "事件内容过大" } };
  if (!await verifyWebhookSignature(secret, raw, request.headers.get("x-hub-signature-256"))) {
    return { httpStatus: 401, body: { error: "签名验证失败" } };
  }
  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  const event = request.headers.get("x-github-event") ?? "";
  if (!DELIVERY_ID.test(deliveryId) || !EVENT_NAME.test(event)) return { httpStatus: 400, body: { error: "缺少投递标识或事件类型" } };
  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as Payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("not an object");
  } catch { return { httpStatus: 400, body: { error: "事件内容无效" } }; }

  const action = str(payload.action, 64);
  const installationId = int(payload.installation?.id);
  const repositoryId = int(payload.repository?.id);
  const payloadSha256 = await sha256Hex(raw);
  // The delivery row is the dedupe key: a replay never reaches processing.
  // A delivery whose earlier processing failed may be retried (GitHub
  // "redeliver" keeps the same ID); every handler below is idempotent.
  const claimed = await d1.prepare(`INSERT INTO github_webhook_deliveries
      (delivery_id, event, action, installation_id, repository_id, payload_sha256, status)
      VALUES (?, ?, ?, ?, ?, ?, 'received')
      ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id`)
    .bind(deliveryId, event, action, installationId, repositoryId, payloadSha256).first();
  if (!claimed) {
    const retried = await d1.prepare(`UPDATE github_webhook_deliveries SET status = 'received', error = ''
      WHERE delivery_id = ? AND status = 'failed' AND payload_sha256 = ? RETURNING delivery_id`)
      .bind(deliveryId, payloadSha256).first();
    if (!retried) return { httpStatus: 200, body: { ok: true, duplicate: true } };
  }

  let outcome: Outcome;
  try {
    outcome = await processEvent(d1, event, action, payload, context);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "processing failed";
    await d1.prepare(`UPDATE github_webhook_deliveries SET status = 'failed', error = ?, processed_at = CURRENT_TIMESTAMP
      WHERE delivery_id = ?`).bind(message, deliveryId).run();
    return { httpStatus: 500, body: { error: "事件处理失败" } };
  }
  await d1.prepare(`UPDATE github_webhook_deliveries SET status = ?, origin = ?, error = ?, summary_json = ?,
      processed_at = CURRENT_TIMESTAMP WHERE delivery_id = ?`)
    .bind(outcome.status, outcome.origin, outcome.reason, JSON.stringify(outcome.summary), deliveryId).run();
  return { httpStatus: 200, body: { ok: true, status: outcome.status, origin: outcome.origin, reason: outcome.reason } };
}

function isAppBot(payload: Payload, context: WebhookContext) {
  return Boolean(context.appSlug) && str(payload.sender?.login) === `${context.appSlug}[bot]`;
}

async function processEvent(d1: D1Database, event: string, action: string, payload: Payload, context: WebhookContext): Promise<Outcome> {
  const installationId = int(payload.installation?.id);
  const base = { action, installationId, repositoryId: int(payload.repository?.id) };
  const ignored = (reason: string, origin: Outcome["origin"] = "external", summary: Outcome["summary"] = base): Outcome => (
    { status: "ignored", origin, reason, summary }
  );
  if (isAppBot(payload, context)) return ignored("platform_sender", "platform_echo");

  if (event === "installation") return handleInstallation(d1, action, payload, context, base, ignored);
  if (event === "installation_repositories") {
    if (!installationId) return ignored("missing_installation");
    const removed = (payload.repositories_removed ?? []).map((repository) => int(repository?.id)).filter((id): id is number => id !== null);
    const summary = { ...base, repositoriesRemoved: removed.slice(0, 100) };
    const selection = str(payload.repository_selection);
    const statements = [];
    if (selection === "all" || selection === "selected") {
      statements.push(d1.prepare(`UPDATE github_installations SET repository_selection = ?, updated_at = CURRENT_TIMESTAMP
        WHERE installation_id = ?`).bind(selection, installationId));
    }
    for (let index = 0; index < removed.length; index += 50) {
      const chunk = removed.slice(index, index + 50);
      statements.push(d1.prepare(`UPDATE repository_links SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
        WHERE installation_id = ? AND status = 'active' AND github_repository_id IN (${chunk.map(() => "?").join(",")})`)
        .bind(installationId, ...chunk));
    }
    if (statements.length) await d1.batch(statements);
    return { status: "processed", origin: "external", reason: "", summary };
  }
  if (event === "pull_request") return handlePullRequest(d1, action, payload, base, ignored);
  return ignored("unhandled_event");
}

async function handleInstallation(
  d1: D1Database, action: string, payload: Payload, context: WebhookContext,
  base: Outcome["summary"], ignored: (reason: string) => Outcome,
): Promise<Outcome> {
  const installation = payload.installation;
  const installationId = int(installation?.id);
  if (!installationId) return ignored("missing_installation");
  const appId = int(installation?.app_id);
  if (context.appId && /^\d+$/.test(context.appId) && appId !== Number(context.appId)) return ignored("app_mismatch");
  const status = action === "deleted" ? "deleted" : action === "suspend" ? "suspended"
    : ["created", "unsuspend", "new_permissions_accepted"].includes(action) ? "active" : null;
  if (!status) return ignored("unhandled_action");
  const selection = str(installation?.repository_selection) === "all" ? "all" : "selected";
  const statements = [d1.prepare(`INSERT INTO github_installations
      (installation_id, account_login, account_type, repository_selection, status)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(installation_id) DO UPDATE SET account_login = excluded.account_login, account_type = excluded.account_type,
        repository_selection = excluded.repository_selection, status = excluded.status, updated_at = CURRENT_TIMESTAMP`)
    .bind(installationId, str(installation?.account?.login, 100), str(installation?.account?.type, 40), selection, status)];
  if (status === "deleted") {
    statements.push(d1.prepare(`UPDATE repository_links SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
      WHERE installation_id = ? AND status = 'active'`).bind(installationId));
  }
  await d1.batch(statements);
  return { status: "processed", origin: "external", reason: "", summary: { ...base, installationStatus: status } };
}

type LinkedChangeRequest = {
  id: string;
  branch_name: string;
  status: string;
  head_commit_sha: string | null;
  link_installation_id: number | null;
};

async function handlePullRequest(
  d1: D1Database, action: string, payload: Payload,
  base: Outcome["summary"], ignored: (reason: string, origin?: Outcome["origin"], summary?: Outcome["summary"]) => Outcome,
): Promise<Outcome> {
  const installationId = int(payload.installation?.id);
  const repositoryId = int(payload.repository?.id);
  const pull = payload.pull_request;
  const number = int(pull?.number) ?? int(payload.number);
  const headRef = str(pull?.head?.ref, 255);
  const headSha = str(pull?.head?.sha, 40).toLowerCase();
  const merged = pull?.merged === true;
  const summary = { ...base, prNumber: number, headRef: headRef || null, headSha: /^[0-9a-f]{40}$/.test(headSha) ? headSha : null, merged };
  if (!installationId || !repositoryId || !number) return ignored("missing_identity", "external", summary);
  // The platform opens PRs itself; that `opened` event is its own echo.
  if (action === "opened" && str(pull?.body, 100).startsWith(PLATFORM_ORIGIN_MARKER)) return ignored("platform_marker", "platform_echo", summary);

  const row = await d1.prepare(`SELECT cr.id, cr.branch_name, cr.status, cr.head_commit_sha, rl.installation_id AS link_installation_id
      FROM change_requests cr
      LEFT JOIN repository_links rl ON rl.student_id = cr.student_id AND rl.github_repository_id = cr.github_repository_id
      WHERE cr.github_repository_id = ? AND (cr.pr_number = ? OR (cr.pr_number IS NULL AND cr.branch_name = ?))
      ORDER BY cr.pr_number IS NULL LIMIT 1`)
    .bind(repositoryId, number, headRef).first<LinkedChangeRequest>();
  if (!row) return ignored("unknown_pull_request", "external", summary);
  if (Number(row.link_installation_id) !== installationId) return ignored("installation_mismatch", "external", summary);
  if (headRef !== row.branch_name) return ignored("branch_mismatch", "external", summary);

  let result: D1Result | null = null;
  if (action === "closed") {
    result = await d1.prepare(`UPDATE change_requests SET status = ?, pr_number = COALESCE(pr_number, ?),
        head_commit_sha = COALESCE(?, head_commit_sha), version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('open', 'publishing')`)
      .bind(merged ? "merged" : "closed", number, summary.headSha, row.id).run();
  } else if (action === "reopened") {
    result = await d1.prepare(`UPDATE change_requests SET status = 'open', version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'closed'`).bind(row.id).run();
  } else if (action === "synchronize") {
    if (!summary.headSha) return ignored("missing_head", "external", summary);
    result = await d1.prepare(`UPDATE change_requests SET head_commit_sha = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('open', 'publishing') AND (head_commit_sha IS NULL OR head_commit_sha <> ?)`)
      .bind(summary.headSha, row.id, summary.headSha).run();
  } else {
    return ignored("unhandled_action", "external", summary);
  }
  return {
    status: "processed", origin: "external", reason: result.meta.changes ? "" : "no_change",
    summary: { ...summary, changeRequestId: row.id },
  };
}
