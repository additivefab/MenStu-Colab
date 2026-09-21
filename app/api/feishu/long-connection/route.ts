import { getFeishuBotConfig } from "../../../../lib/feishu-auth";
import { FeishuBotConfigError } from "../../../../lib/feishu-bot-config";
import { verifyLongConnectionRelay } from "../../../../lib/feishu-long-connection";
import { type FeishuMessageEvent, stageFeishuMeetingSummary } from "../../../../lib/feishu-message-import";

type LongConnectionEvent = FeishuMessageEvent & {
  app_id?: string;
  event_id?: string;
  event_type?: string;
};

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    if (rawBody.length > 220_000) return Response.json({ error: "事件内容过大" }, { status: 413 });
    const config = getFeishuBotConfig();
    if (!config.appId || !config.appSecret) {
      return Response.json({ error: "飞书长连接尚未配置" }, { status: 503 });
    }
    // 长连接事件不含 webhook Verification Token；桥接请求使用 App Secret 派生的短时 HMAC 鉴权。
    if (!await verifyLongConnectionRelay(rawBody, request.headers, config.appSecret)) {
      return Response.json({ error: "长连接中继签名无效" }, { status: 403 });
    }

    const event = JSON.parse(rawBody) as LongConnectionEvent;
    if (event.event_type && event.event_type !== "im.message.receive_v1") return Response.json({ code: 0 });
    if ((config.mode === "dedicated" || event.app_id) && event.app_id !== config.appId) {
      return Response.json({ error: "事件应用不匹配" }, { status: 403 });
    }
    const messageId = event.message?.message_id ?? "";
    const result = await stageFeishuMeetingSummary(event.event_id || `ws:${messageId}`, event);
    return Response.json({ code: 0, ...result });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "飞书长连接事件处理失败" },
      { status: error instanceof FeishuBotConfigError ? 503 : 400 },
    );
  }
}
