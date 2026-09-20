import { ensureDatabase, getD1 } from "./database";
import { LocalAuthError, takeAuthAttempt } from "./local-auth-service";

export const privateAuthHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
export async function readLocalAuthBody(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new LocalAuthError("请求来源无效", 403);
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new LocalAuthError("请求格式无效", 415);
  // Bound the actual stream as well as the declared size.
  const reader = request.body?.getReader();
  if (!reader) throw new LocalAuthError("请求不能为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new LocalAuthError("请求过大", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new LocalAuthError("请求格式无效"); }
}
export async function limitLocalAuthRequest(request: Request) {
  await ensureDatabase();
  // CF supplies this header; never trust user-supplied X-Forwarded-For.
  await takeAuthAttempt(getD1(), "ip", request.headers.get("cf-connecting-ip") ?? "local-development", 100);
}
export function localAuthFailure(error: unknown) {
  const known = error instanceof LocalAuthError;
  const status = known ? error.status : 500;
  return Response.json({ error: known ? error.message : "登录服务暂时不可用，请稍后重试" }, {
    status, headers: { ...privateAuthHeaders, ...(status === 429 ? { "Retry-After": "900" } : {}) },
  });
}
