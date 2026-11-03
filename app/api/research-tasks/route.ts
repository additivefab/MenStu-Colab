import { canViewStudent } from "../../../lib/authorization";
import { getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import {
  confirmTask, createTask, endTask, forbiddenError, inputError, listResearchTasks, parseEntityId, privateJson,
  privateResponse, readJsonBody, researchLoopFailure, researchTaskDetail, reviseTask,
} from "../../../lib/research-tasks-service";

const FALLBACK = "研究任务暂时不可用，请稍后重试";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    const params = new URL(request.url).searchParams;
    const d1 = getD1();
    if (params.get("taskId")) {
      return privateJson(await researchTaskDetail(d1, auth.user, parseEntityId(params.get("taskId"), "任务")));
    }
    if (!params.get("studentId")) throw inputError("请提供 studentId 或 taskId");
    const studentId = parseEntityId(params.get("studentId"), "学生");
    if (!(await canViewStudent(auth.user, studentId))) throw forbiddenError("无权查看该学生的研究任务");
    return privateJson({ tasks: await listResearchTasks(d1, studentId) });
  } catch (error) { return researchLoopFailure(error, FALLBACK); }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return privateJson({ code: "BAD_ORIGIN", error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    const body = await readJsonBody(request);
    const d1 = getD1();
    switch (body.action) {
      case "create": return privateJson(await createTask(d1, auth.user, body));
      case "revise": return privateJson(await reviseTask(d1, auth.user, body));
      case "confirm": return privateJson(await confirmTask(d1, auth.user, body));
      case "close": return privateJson(await endTask(d1, auth.user, body, "close"));
      case "cancel": return privateJson(await endTask(d1, auth.user, body, "cancel"));
      default: throw inputError("不支持的操作");
    }
  } catch (error) { return researchLoopFailure(error, FALLBACK); }
}
