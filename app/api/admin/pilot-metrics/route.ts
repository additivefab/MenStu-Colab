import { getD1 } from "../../../../lib/database";
import { requireAppUser } from "../../../../lib/feishu-auth";
import { PilotInputError, parsePilotPeriod, readPilotMetrics } from "../../../../lib/loop-pilot-metrics";

// Pilot process metrics (plan G5). Superadmin only, read-only, aggregate
// numbers over the whole pilot: no per-student or per-user fields, no ranking.

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function privateAuthResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin"]);
    if (auth.response) return privateAuthResponse(auth.response);
    const params = new URL(request.url).searchParams;
    let period;
    try { period = parsePilotPeriod(params.get("from"), params.get("to")); }
    catch (error) {
      if (error instanceof PilotInputError) return json({ code: "INVALID_INPUT", error: error.message }, 400);
      throw error;
    }
    return json(await readPilotMetrics(getD1(), period));
  } catch (error) {
    console.error("pilot metrics failure", error);
    return json({ code: "INTERNAL", error: "试点流程指标暂时无法生成，请稍后重试" }, 500);
  }
}
