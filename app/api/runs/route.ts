import { getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import {
  approveRun, cancelRun, createRun, privateResponse, readJsonBody, rerunRun, revokeApproval, runFailure, runJson,
} from "../../../lib/run-registry-service";
import { listRuns, readRunDetail } from "../../../lib/run-results-service";

const FALLBACK = "运行登记暂时不可用，请稍后重试";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    const params = new URL(request.url).searchParams;
    const runId = params.get("runId");
    if (runId !== null) return runJson(await readRunDetail(getD1(), auth.user, runId));
    return runJson(await listRuns(getD1(), auth.user, { taskId: params.get("taskId"), studentId: params.get("studentId") }));
  } catch (error) { return runFailure(error, FALLBACK); }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return runJson({ code: "FORBIDDEN", error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    const body = await readJsonBody(request);
    const d1 = getD1();
    switch (body.action) {
      case "create": return runJson(await createRun(d1, auth.user, body));
      case "approve": return runJson(await approveRun(d1, auth.user, body));
      case "revoke_approval": return runJson(await revokeApproval(d1, auth.user, body));
      case "cancel": return runJson(await cancelRun(d1, auth.user, body));
      case "rerun": return runJson(await rerunRun(d1, auth.user, body));
      default: return runJson({ code: "INVALID_INPUT", error: "未知操作" }, 400);
    }
  } catch (error) { return runFailure(error, FALLBACK); }
}
