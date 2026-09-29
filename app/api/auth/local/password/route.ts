import { getD1 } from "../../../../../lib/database";
import { clearPersonaCookie, clearSessionCookie, requestSessionHash, requireAppUser } from "../../../../../lib/feishu-auth";
import { changeLocalPassword, localAccountForUser } from "../../../../../lib/local-auth-service";
import { limitLocalAuthRequest, localAuthFailure, privateAuthHeaders, readLocalAuthBody } from "../../../../../lib/local-auth-http";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["student", "admin", "superadmin"], true);
    if ("response" in auth) return auth.response;
    const account = await localAccountForUser(getD1(), auth.user.id);
    return Response.json({ username: account?.username ?? null, enabled: Boolean(account?.enabled) }, { headers: privateAuthHeaders });
  } catch (error) { return localAuthFailure(error); }
}

export async function POST(request: Request) {
  try {
    const body = await readLocalAuthBody(request);
    const auth = await requireAppUser(request, ["student", "admin", "superadmin"], true);
    if ("response" in auth) return auth.response;
    await limitLocalAuthRequest(request);
    // The target comes exclusively from the authenticated session, never the request body.
    await changeLocalPassword(getD1(), auth.user.id, await requestSessionHash(request), body.currentPassword, body.newPassword);
    const headers = new Headers(privateAuthHeaders);
    headers.append("Set-Cookie", clearSessionCookie());
    headers.append("Set-Cookie", clearPersonaCookie());
    return Response.json({ message: "密码已修改，请重新登录" }, { headers });
  } catch (error) { return localAuthFailure(error); }
}
