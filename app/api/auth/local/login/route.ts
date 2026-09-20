import { getD1 } from "../../../../../lib/database";
import { clearPersonaCookie, sessionCookie } from "../../../../../lib/feishu-auth";
import { loginLocally } from "../../../../../lib/local-auth-service";
import { limitLocalAuthRequest, localAuthFailure, privateAuthHeaders, readLocalAuthBody } from "../../../../../lib/local-auth-http";

export async function POST(request: Request) {
  try {
    const body = await readLocalAuthBody(request);
    await limitLocalAuthRequest(request);
    const session = await loginLocally(getD1(), body.username, body.password);
    const headers = new Headers(privateAuthHeaders);
    headers.append("Set-Cookie", sessionCookie(session.token, session.expiresAt));
    headers.append("Set-Cookie", clearPersonaCookie());
    return Response.json({ message: "登录成功" }, { headers });
  } catch (error) { return localAuthFailure(error); }
}
