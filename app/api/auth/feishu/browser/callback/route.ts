import {
  createFeishuSession,
  exchangeFeishuCode,
  sessionCookie,
} from "../../../../../../lib/feishu-auth";

const OAUTH_STATE_COOKIE = "tanyan_feishu_oauth_state";

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function clearOauthStateCookie() {
  return `${OAUTH_STATE_COOKIE}=; Path=/api/auth/feishu/browser; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function errorPage(message: string, status = 400) {
  const safeMessage = message.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
  return new Response(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>飞书登录失败</title><body><main><h1>飞书登录未完成</h1><p>${safeMessage}</p><p><a href="/api/auth/feishu/browser/start">重新登录</a></p></main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": clearOauthStateCookie(),
      },
    },
  );
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code")?.trim() ?? "";
  const state = requestUrl.searchParams.get("state")?.trim() ?? "";
  const expectedState = readCookie(request, OAUTH_STATE_COOKIE);

  if (!code || !state || !expectedState || state !== expectedState) {
    return errorPage("授权请求已失效，请重新发起登录。");
  }

  try {
    const info = await exchangeFeishuCode(code);
    const session = await createFeishuSession(info);
    const headers = new Headers({
      Location: new URL("/", request.url).toString(),
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", sessionCookie(session.token, session.expiresAt));
    headers.append("Set-Cookie", clearOauthStateCookie());
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return errorPage(error instanceof Error ? error.message : "飞书登录失败", 502);
  }
}
