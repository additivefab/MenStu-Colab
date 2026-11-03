import { env } from "cloudflare:workers";
import {
  claimAgentAttempt, heartbeatAgentAttempt, recordAgentEvents, submitAgentResult,
} from "../../../../lib/agent-attempts-service";
import { ensureDatabase, getD1 } from "../../../../lib/database";
import { authenticateLabRunner } from "../../../../lib/lab-runner-auth";
import { LIMITS } from "../../../../lib/research-loop/contracts";
import {
  inputError, privateJson, privateResponse, readJsonBody, researchLoopFailure,
} from "../../../../lib/research-tasks-service";

// Agent-worker protocol (lib/research-loop/contracts.ts). Bearer runner token
// only; no user session and no same-origin requirement.
const FALLBACK = "平台暂时无法处理代理工作进程请求";
// files (base64) + diff + JSON overhead.
const MAX_RESULT_BYTES = Math.ceil(LIMITS.maxChangeTotalBytes * 4 / 3) + LIMITS.maxDiffBytes * 2 + 1_000_000;

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const d1 = getD1();
    const auth = await authenticateLabRunner(d1, request, "agent");
    if (auth.response) return privateResponse(auth.response);
    const body = await readJsonBody(request, MAX_RESULT_BYTES);
    switch (body.action) {
      case "claim": return privateJson(await claimAgentAttempt(d1, auth.runner));
      case "heartbeat": return privateJson(await heartbeatAgentAttempt(d1, auth.runner, body));
      case "events": return privateJson(await recordAgentEvents(d1, auth.runner, body));
      case "result": return privateJson(await submitAgentResult(d1, env.FILES, auth.runner, body));
      default: throw inputError("不支持的操作");
    }
  } catch (error) { return researchLoopFailure(error, FALLBACK); }
}
