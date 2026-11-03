import { getD1 } from "../../../lib/database";
import { requireAppUser } from "../../../lib/feishu-auth";
import { privateResponse, runFailure } from "../../../lib/run-registry-service";
import { readArtifact } from "../../../lib/run-results-service";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateResponse(auth.response);
    return await readArtifact(getD1(), auth.user, new URL(request.url).searchParams.get("artifactId"));
  } catch (error) { return runFailure(error, "产物读取失败，请稍后重试"); }
}
