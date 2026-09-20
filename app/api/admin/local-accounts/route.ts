import { getD1 } from "../../../../lib/database";
import { requireAppUser } from "../../../../lib/feishu-auth";
import { disableLocalLogin, issueLocalActivation, LocalAuthError } from "../../../../lib/local-auth-service";
import { localAuthFailure, privateAuthHeaders, readLocalAuthBody } from "../../../../lib/local-auth-http";

export async function POST(request: Request) {
  try {
    const body = await readLocalAuthBody(request);
    const auth = await requireAppUser(request, ["superadmin"]);
    if ("response" in auth) return auth.response;
    if (!Number.isSafeInteger(body.userId) || typeof body.studentId !== "string" || !body.studentId
      || !["issue", "disable"].includes(String(body.action))) throw new LocalAuthError("账号参数无效");
    if (body.action === "disable") {
      await disableLocalLogin(getD1(), auth.user.id, body.userId as number, body.studentId);
      return Response.json({ message: "独立登录已停用，现有会话已退出" }, { headers: privateAuthHeaders });
    }
    const { token, ...result } = await issueLocalActivation(getD1(), auth.user.id, body.userId as number, body.studentId);
    // Fragment is never sent with page requests or in a Referer header.
    const url = new URL("/activate", request.url);
    url.hash = `token=${token}`;
    return Response.json({ ...result, activationUrl: url.toString() }, { headers: privateAuthHeaders });
  } catch (error) { return localAuthFailure(error); }
}
