import {
  agentAttemptDetail, cancelAgentAttempt, decideAgentPlan, listTaskAttempts, startAgentAttempt,
} from "../../../lib/agent-attempts-service";
import { getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import {
  inputError, parseEntityId, privateJson, privateResponse, readJsonBody, researchLoopFailure,
} from "../../../lib/research-tasks-service";

const FALLBACK = "代理尝试暂时不可用，请稍后重试";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    const params = new URL(request.url).searchParams;
    const d1 = getD1();
    if (params.get("attemptId")) {
      const raw = params.get("afterSequence") ?? "0";
      if (!/^\d{1,15}$/.test(raw)) throw inputError("afterSequence 参数无效");
      return privateJson(await agentAttemptDetail(d1, auth.user, parseEntityId(params.get("attemptId"), "代理尝试"), Number(raw)));
    }
    if (!params.get("taskId")) throw inputError("请提供 taskId 或 attemptId");
    return privateJson(await listTaskAttempts(d1, auth.user, parseEntityId(params.get("taskId"), "任务")));
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
      case "start": return privateJson(await startAgentAttempt(d1, auth.user, body));
      case "cancel": return privateJson(await cancelAgentAttempt(d1, auth.user, body));
      case "decide_plan": return privateJson(await decideAgentPlan(d1, auth.user, body));
      default: throw inputError("不支持的操作");
    }
  } catch (error) { return researchLoopFailure(error, FALLBACK); }
}
