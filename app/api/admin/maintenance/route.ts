import { getD1 } from "../../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../../lib/feishu-auth";
import { authenticateLabRunner } from "../../../../lib/lab-runner-auth";
import { redactReportIds, runLoopMaintenance } from "../../../../lib/loop-maintenance";
import { privateResponse, readJsonBody, runFailure, runJson } from "../../../../lib/run-registry-service";

// G2 compensating reconciliation (lib/loop-maintenance.ts), manual trigger.
// - Superadmin session, same origin: {action: "run" | "dry_run", finalizeStaleRuns?: boolean}
//   → full report (counts + ids).
// - Compute runner bearer token (cron on the lab runner host, for deployments
//   without Worker cron triggers): {action: "run" | "dry_run"} only, never
//   finalizes stale runs, gets counts without ids, and is throttled per isolate.

const FALLBACK = "平台对账暂时不可用，请稍后重试";
const RUNNER_MIN_INTERVAL_MS = 60_000;
let lastRunnerTrigger = 0;

function parseAction(body: Record<string, unknown>) {
  if (body.action !== "run" && body.action !== "dry_run") return null;
  if (body.finalizeStaleRuns !== undefined && typeof body.finalizeStaleRuns !== "boolean") return null;
  return { dryRun: body.action === "dry_run", finalizeStaleRuns: body.finalizeStaleRuns === true };
}

export async function POST(request: Request) {
  try {
    const d1 = getD1();
    const origin = new URL(request.url).origin;
    if (request.headers.has("authorization")) {
      const auth = await authenticateLabRunner(d1, request, "compute");
      if (auth.response) return privateResponse(auth.response);
      const action = parseAction(await readJsonBody(request, 10_000));
      if (!action) return runJson({ code: "INVALID_INPUT", error: "操作无效" }, 400);
      if (action.finalizeStaleRuns) return runJson({ code: "FORBIDDEN", error: "执行器不能收尾长时间失联的运行" }, 403);
      const now = Date.now();
      if (now - lastRunnerTrigger < RUNNER_MIN_INTERVAL_MS) return runJson({ code: "TOO_SOON", error: "对账刚刚执行过，请稍后再试" }, 429);
      lastRunnerTrigger = now;
      const report = await runLoopMaintenance(d1, {}, { now: new Date(now), dryRun: action.dryRun, origin });
      return runJson({ report: redactReportIds(report) });
    }
    if (!assertSameOrigin(request)) return runJson({ code: "FORBIDDEN", error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin"]);
    if (auth.response) return privateResponse(auth.response);
    const action = parseAction(await readJsonBody(request, 10_000));
    if (!action) return runJson({ code: "INVALID_INPUT", error: "操作无效" }, 400);
    const report = await runLoopMaintenance(d1, {}, { dryRun: action.dryRun, finalizeStaleRuns: action.finalizeStaleRuns, origin });
    return runJson({ report });
  } catch (error) { return runFailure(error, FALLBACK); }
}
