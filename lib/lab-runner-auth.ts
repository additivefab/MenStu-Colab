import { sha256Hex } from "./research-loop/contracts.ts";

export type LabRunner = { id: string; label: string; kind: "compute" | "agent" };

function denied(status: 401 | 403, code: string, error: string) {
  return Response.json({ code, error }, { status, headers: { "Cache-Control": "private, no-store" } });
}

// Lab runners and agent workers authenticate with a per-runner bearer token
// issued once by a superadmin; only its SHA-256 is stored (lab_runners).
export async function authenticateLabRunner(
  d1: D1Database,
  request: Request,
  kind: LabRunner["kind"],
): Promise<{ runner: LabRunner; response?: never } | { runner?: never; response: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(header);
  if (!match) return { response: denied(401, "RUNNER_AUTH_REQUIRED", "缺少执行器凭据") };
  const runner = await d1.prepare(`SELECT id, label, kind FROM lab_runners
    WHERE token_sha256 = ? AND status = 'active'`).bind(await sha256Hex(match[1])).first<LabRunner>();
  if (!runner) return { response: denied(401, "RUNNER_AUTH_INVALID", "执行器凭据无效或已停用") };
  if (runner.kind !== kind) return { response: denied(403, "RUNNER_KIND_MISMATCH", "执行器类型不匹配") };
  await d1.prepare("UPDATE lab_runners SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").bind(runner.id).run();
  return { runner };
}

/** Returns a new random runner token (shown once) and its stored hash. */
export async function issueRunnerToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return { token, tokenSha256: await sha256Hex(token) };
}
