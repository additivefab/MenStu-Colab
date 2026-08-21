import { getFeishuConfig, isFeishuConfigured } from "../../../../../../lib/feishu-auth";

const OAUTH_STATE_COOKIE = "tanyan_feishu_oauth_state";
const OAUTH_STATE_SECONDS = 10 * 60;

function randomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function GET(request: Request) {
  if (!isFeishuConfigured()) {
    return Response.json({ error: "飞书企业自建应用尚未配置" }, { status: 503 });
  }

  const state = randomState();
  const callbackUrl = new URL("/api/auth/feishu/browser/callback", request.url);
  const authorizeUrl = new URL("https://open.feishu.cn/open-apis/authen/v1/index");
  authorizeUrl.searchParams.set("app_id", getFeishuConfig().appId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  authorizeUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": `${OAUTH_STATE_COOKIE}=${state}; Path=/api/auth/feishu/browser; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_STATE_SECONDS}`,
    },
  });
}
