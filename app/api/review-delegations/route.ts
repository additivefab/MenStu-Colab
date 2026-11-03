import { getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import { privateJson, privateResponse, readJsonBody, ResearchLoopHttpError } from "../../../lib/research-tasks-service";
import {
  ReviewDelegationError, grantDelegation, listMyDelegatedStudents, listStudentDelegations, parseStudentId, revokeDelegation,
} from "../../../lib/review-delegation";

// FB1 peer code review delegations. GET ?studentId= (managers) or ?mine=1
// (the delegate's own students); POST grant / revoke.

function failure(error: unknown) {
  if (error instanceof ReviewDelegationError || error instanceof ResearchLoopHttpError) {
    return privateJson({ code: error.code, error: error.message }, error.status);
  }
  console.error("review delegation failed", error instanceof Error ? error.message : String(error));
  return privateJson({ code: "INTERNAL", error: "代码审查委托暂时不可用，请稍后重试" }, 500);
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    const params = new URL(request.url).searchParams;
    if (params.get("mine") === "1") return privateJson(await listMyDelegatedStudents(getD1(), auth.user));
    if (!params.get("studentId")) throw new ReviewDelegationError(400, "INVALID_INPUT", "请提供 studentId 或 mine=1");
    return privateJson(await listStudentDelegations(getD1(), auth.user, parseStudentId(params.get("studentId"))));
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return privateJson({ code: "BAD_ORIGIN", error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    const body = await readJsonBody(request, 8_000);
    const d1 = getD1();
    if (body.action === "grant") return privateJson(await grantDelegation(d1, auth.user, body));
    if (body.action === "revoke") return privateJson(await revokeDelegation(d1, auth.user, body));
    throw new ReviewDelegationError(400, "INVALID_INPUT", "不支持的操作");
  } catch (error) { return failure(error); }
}
