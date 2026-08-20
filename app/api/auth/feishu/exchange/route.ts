import {
  assertSameOrigin,
  createFeishuSession,
  exchangeFeishuCode,
  sessionCookie,
} from "../../../../../lib/feishu-auth";

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) {
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    }
    const body = (await request.json()) as { code?: string };
    const code = body.code?.trim() ?? "";
    if (!code || code.length > 2048) {
      return Response.json({ error: "飞书授权码无效" }, { status: 400 });
    }

    const info = await exchangeFeishuCode(code);
    const session = await createFeishuSession(info);
    return Response.json(
      { user: session.user },
      { headers: { "Set-Cookie": sessionCookie(session.token, session.expiresAt) } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "飞书登录失败" },
      { status: 502 },
    );
  }
}
