import { getD1 } from "../../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../../lib/feishu-auth";
import {
  GithubAdminConflictError, GithubAdminInputError, checkRepositoryAccess, linkRepository, readGithubAdminState, revokeLink, syncInstallations,
} from "../../../../lib/github/admin-service";
import { GithubKeyFormatError } from "../../../../lib/github/app-jwt";
import { GithubApiError } from "../../../../lib/github/http";
import { GithubNotConfiguredError } from "../../../../lib/github/tokens";

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function privateAuthResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function failure(error: unknown) {
  if (error instanceof GithubAdminInputError) return json({ error: error.message }, 400);
  if (error instanceof GithubAdminConflictError) return json({ error: error.message }, 409);
  if (error instanceof GithubNotConfiguredError) return json({ error: "GitHub App 尚未配置", code: "GITHUB_NOT_CONFIGURED" }, 503);
  if (error instanceof GithubKeyFormatError) return json({ error: error.message, code: "GITHUB_NOT_CONFIGURED" }, 503);
  if (error instanceof GithubApiError) return json({ error: error.message, code: "GITHUB_ERROR" }, 502);
  return json({ error: "GitHub 管理暂时不可用，请稍后重试" }, 500);
}

function studentIdOf(body: Record<string, unknown>) {
  if (typeof body.studentId !== "string" || !body.studentId.trim() || body.studentId.trim().length > 80) {
    throw new GithubAdminInputError("学生参数无效");
  }
  return body.studentId.trim();
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin"]);
    if (auth.response) return privateAuthResponse(auth.response);
    return json(await readGithubAdminState(getD1()));
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return json({ error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin"]);
    if (auth.response) return privateAuthResponse(auth.response);
    let body: unknown;
    try { body = await request.json(); } catch { throw new GithubAdminInputError("请求内容无效"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new GithubAdminInputError("请求内容无效");
    const input = body as Record<string, unknown>;
    // Repository identity is never accepted from the client (T03).
    if ("repositoryId" in input || "installationId" in input || "fullName" in input) {
      throw new GithubAdminInputError("不接受客户端提交的仓库标识");
    }
    const d1 = getD1();
    let result: unknown;
    if (input.action === "sync_installations") result = await syncInstallations(d1);
    else if (input.action === "link_repository") result = await linkRepository(d1, studentIdOf(input), auth.user.id);
    else if (input.action === "check_access") result = await checkRepositoryAccess(d1, studentIdOf(input), input.ref);
    else if (input.action === "revoke_link") result = await revokeLink(d1, studentIdOf(input));
    else throw new GithubAdminInputError("不支持的操作");
    return json({ result, ...await readGithubAdminState(d1) });
  } catch (error) { return failure(error); }
}
