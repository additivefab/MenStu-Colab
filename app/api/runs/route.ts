import { getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import {
  approveRun, cancelRun, createRun, privateResponse, readEvaluationBudget, readJsonBody, readRunValidityViews, rerunRun, revokeApproval,
  runFailure, runJson, setRunBaseline,
} from "../../../lib/run-registry-service";
import { listRuns, readRunDetail } from "../../../lib/run-results-service";

const FALLBACK = "运行登记暂时不可用，请稍后重试";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    const params = new URL(request.url).searchParams;
    const d1 = getD1();
    if (params.get("view") === "evaluation_budget") {
      return runJson(await readEvaluationBudget(d1, auth.user, {
        taskId: params.get("taskId"), evaluationProtocolSha256: params.get("evaluationProtocolSha256"),
      }));
    }
    const runId = params.get("runId");
    if (runId !== null) {
      // readRunDetail checks view scope; batch 6 adds the evaluation budget
      // and reproduction views (lib/research-loop/results-contract.ts).
      const detail = await readRunDetail(d1, auth.user, runId);
      const validity = await readRunValidityViews(d1, {
        id: detail.run.id, runSpecSha256: detail.run.runSpecSha256, attempt: detail.run.attempt, status: detail.run.status,
      }, detail.spec);
      return runJson({ ...detail, ...validity });
    }
    return runJson(await listRuns(d1, auth.user, { taskId: params.get("taskId"), studentId: params.get("studentId") }));
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
      case "set_baseline": return runJson(await setRunBaseline(d1, auth.user, body));
      default: return runJson({ code: "INVALID_INPUT", error: "未知操作" }, 400);
    }
  } catch (error) { return runFailure(error, FALLBACK); }
}
