import { changeCredentialProfile, listCredentialProfiles } from "../../../../lib/agent-attempts-service";
import { getD1 } from "../../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../../lib/feishu-auth";
import { privateJson, privateResponse, readJsonBody, researchLoopFailure } from "../../../../lib/research-tasks-service";

// Superadmin mapping user ↔ provider ↔ agent worker. Credentials live only on
// the worker (spec D3); this endpoint rejects any extra field.
const FALLBACK = "代理凭据档案暂时不可用，请稍后重试";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin"]);
    if (auth.response) return privateResponse(auth.response);
    return privateJson(await listCredentialProfiles(getD1()));
  } catch (error) { return researchLoopFailure(error, FALLBACK); }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return privateJson({ code: "BAD_ORIGIN", error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin"]);
    if (auth.response) return privateResponse(auth.response);
    return privateJson(await changeCredentialProfile(getD1(), auth.user, await readJsonBody(request)));
  } catch (error) { return researchLoopFailure(error, FALLBACK); }
}
