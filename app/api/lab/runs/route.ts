import { ensureDatabase, getD1 } from "../../../../lib/database";
import { authenticateLabRunner } from "../../../../lib/lab-runner-auth";
import {
  claimRun, completeRun, heartbeatRun, readJsonBody, reconcileRun, runFailure, runJson,
} from "../../../../lib/run-registry-service";

// Compute runner protocol (lib/research-loop/contracts.ts, Compute* DTOs).
// Completion carries inline published artifacts, hence the larger body cap.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const d1 = getD1();
    const auth = await authenticateLabRunner(d1, request, "compute");
    if (auth.response) return auth.response;
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    switch (body.action) {
      case "claim": return runJson(await claimRun(d1, auth.runner));
      case "heartbeat": return runJson(await heartbeatRun(d1, auth.runner, body));
      case "reconcile": return runJson(await reconcileRun(d1, auth.runner, body));
      case "complete": return runJson(await completeRun(d1, auth.runner, body));
      default: return runJson({ code: "INVALID_INPUT", error: "未知操作" }, 400);
    }
  } catch (error) { return runFailure(error, "运行协议暂时不可用"); }
}
