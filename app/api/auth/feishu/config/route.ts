import { getFeishuConfig, isFeishuConfigured } from "../../../../../lib/feishu-auth";

export async function GET() {
  const config = getFeishuConfig();
  return Response.json({
    configured: isFeishuConfigured(),
    appId: isFeishuConfigured() ? config.appId : "",
    sdkUrl: "https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.26.js",
  });
}
