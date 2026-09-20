import { getD1 } from "../../../../../lib/database";
import { activateLocalLogin } from "../../../../../lib/local-auth-service";
import { limitLocalAuthRequest, localAuthFailure, privateAuthHeaders, readLocalAuthBody } from "../../../../../lib/local-auth-http";

export async function POST(request: Request) {
  try {
    const body = await readLocalAuthBody(request);
    await limitLocalAuthRequest(request);
    const result = await activateLocalLogin(getD1(), body.token, body.password);
    return Response.json({ ...result, message: "密码已设置，请使用原学生账号登录" }, { headers: privateAuthHeaders });
  } catch (error) { return localAuthFailure(error); }
}
