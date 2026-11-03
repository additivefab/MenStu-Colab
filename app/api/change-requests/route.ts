import { env } from "cloudflare:workers";
import { getD1 } from "../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../lib/feishu-auth";
import {
  ChangeRequestConflictError, ChangeRequestForbiddenError, ChangeRequestInputError, ChangeRequestNotFoundError,
  approveExtraReview, claimPublish, listTaskChangeRequests, parseExpectedVersion, parseId, readChangeRequestDetail,
  rejectChangeRequest,
} from "../../../lib/github/change-requests-service";
import { GithubKeyFormatError } from "../../../lib/github/app-jwt";
import { GithubApiError } from "../../../lib/github/http";
import {
  PublishBlockedError, PublishConflictError, PublishPolicyError, publishChangeRequest,
} from "../../../lib/github/publisher";
import { GithubNotConfiguredError } from "../../../lib/github/tokens";

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "private, no-store" } });
}

function privateAuthResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function failure(error: unknown) {
  if (error instanceof ChangeRequestInputError) return json({ error: error.message }, 400);
  if (error instanceof ChangeRequestForbiddenError) return json({ error: error.message }, 403);
  if (error instanceof ChangeRequestNotFoundError) return json({ error: error.message }, 404);
  if (error instanceof ChangeRequestConflictError) return json({ error: error.message, code: error.code }, 409);
  return json({ error: "变更请求暂时不可用，请稍后重试" }, 500);
}

function publishFailure(error: unknown) {
  if (error instanceof PublishPolicyError) return { status: 422, code: "POLICY_VIOLATION", error: error.message };
  if (error instanceof PublishBlockedError) return { status: 409, code: "PUBLISH_BLOCKED", error: error.message };
  if (error instanceof PublishConflictError) return { status: 409, code: "BRANCH_CONFLICT", error: error.message };
  if (error instanceof GithubNotConfiguredError || error instanceof GithubKeyFormatError) return { status: 503, code: "GITHUB_NOT_CONFIGURED", error: "GitHub App 尚未配置" };
  if (error instanceof GithubApiError) return { status: 502, code: "GITHUB_ERROR", error: `${error.message}，可稍后重试发布` };
  return { status: 500, code: "PUBLISH_FAILED", error: "发布失败，可稍后重试" };
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await request.json(); }
  catch { throw new ChangeRequestInputError("请求内容无效"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChangeRequestInputError("请求内容无效");
  return body as Record<string, unknown>;
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateAuthResponse(auth.response);
    const params = new URL(request.url).searchParams;
    const changeRequestId = params.get("changeRequestId");
    if (changeRequestId) return json(await readChangeRequestDetail(getD1(), env.FILES, auth.user, parseId(changeRequestId, "cr")));
    return json(await listTaskChangeRequests(getD1(), auth.user, parseId(params.get("taskId"), "task")));
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return json({ error: "请求来源无效" }, 403);
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if (auth.response) return privateAuthResponse(auth.response);
    const body = await bodyObject(request);
    const id = parseId(body.changeRequestId, "cr");
    const d1 = getD1();
    const detail = () => readChangeRequestDetail(d1, env.FILES, auth.user, id);
    if (body.action === "approve_extra_review") {
      await approveExtraReview(d1, auth.user, id, parseExpectedVersion(body));
      return json(await detail());
    }
    if (body.action === "reject") {
      await rejectChangeRequest(d1, auth.user, id, parseExpectedVersion(body));
      return json(await detail());
    }
    if (body.action !== "publish") return json({ error: "不支持的操作" }, 400);
    await claimPublish(d1, auth.user, id, parseExpectedVersion(body));
    try {
      const outcome = await publishChangeRequest(d1, env.FILES, id);
      return json({ ...await detail(), publish: { reusedRef: outcome.reusedRef, reusedPullRequest: outcome.reusedPullRequest } });
    } catch (error) {
      const { status, code, error: message } = publishFailure(error);
      return json({ ...await detail(), error: message, code }, status);
    }
  } catch (error) { return failure(error); }
}
