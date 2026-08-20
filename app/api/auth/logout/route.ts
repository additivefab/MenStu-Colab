import {
  assertSameOrigin,
  clearSessionCookie,
  deleteSession,
} from "../../../../lib/feishu-auth";

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) {
    return Response.json({ error: "请求来源无效" }, { status: 403 });
  }
  await deleteSession(request);
  return Response.json(
    { message: "已退出" },
    { headers: { "Set-Cookie": clearSessionCookie() } },
  );
}
