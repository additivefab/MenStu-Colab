import { getD1 } from "../../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../../lib/feishu-auth";
import { applyLabAdminAction, privateResponse, readJsonBody, readLabRegistry, runFailure, runJson } from "../../../../lib/run-registry-service";

const FALLBACK = "实验室登记暂时不可用，请稍后重试";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin"]);
    if (auth.response) return privateResponse(auth.response);
    return runJson(await readLabRegistry(getD1()));
  } catch (error) { return runFailure(error, FALLBACK); }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return runJson({ code: "FORBIDDEN", error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin"]);
    if (auth.response) return privateResponse(auth.response);
    return runJson(await applyLabAdminAction(getD1(), auth.user, await readJsonBody(request)));
  } catch (error) { return runFailure(error, FALLBACK); }
}
