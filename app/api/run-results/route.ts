import { getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { privateResponse, readJsonBody, runFailure, runJson } from "../../../lib/run-registry-service";
import { applyRunResultAction } from "../../../lib/run-results-service";

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return runJson({ code: "FORBIDDEN", error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    return runJson(await applyRunResultAction(getD1(), auth.user, await readJsonBody(request)));
  } catch (error) { return runFailure(error, "结果评审暂时不可用，请稍后重试"); }
}
