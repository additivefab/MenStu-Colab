import { getFeishuConfig } from "../../../../lib/feishu-auth";
import { parseFeishuEvent, secureTextEqual } from "../../../../lib/feishu-events";
import { stageFeishuMeetingSummary } from "../../../../lib/feishu-message-import";

type FeishuEventPayload = {
  type?: string;
  token?: string;
  challenge?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    app_id?: string;
  };
  event?: {
    sender?: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string; app_id?: string };
      sender_type?: string;
    };
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      create_time?: string;
    };
  };
};

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    if (rawBody.length > 220_000) return Response.json({ error: "事件内容过大" }, { status: 413 });
    const config = getFeishuConfig();
    if (!config.verificationToken) return Response.json({ error: "事件验证尚未配置" }, { status: 503 });
    const payload = await parseFeishuEvent(rawBody, request.headers, config.encryptKey) as FeishuEventPayload;

    if (payload.type === "url_verification") {
      if (!payload.token || !await secureTextEqual(payload.token, config.verificationToken)) {
        return Response.json({ error: "事件验证失败" }, { status: 403 });
      }
      return Response.json({ challenge: payload.challenge ?? "" });
    }

    const header = payload.header;
    if (!header?.token || !await secureTextEqual(header.token, config.verificationToken)) {
      return Response.json({ error: "事件验证失败" }, { status: 403 });
    }
    if (config.appId && header.app_id !== config.appId) {
      return Response.json({ error: "事件应用不匹配" }, { status: 403 });
    }
    if (header.event_type !== "im.message.receive_v1") return Response.json({ code: 0 });

    return Response.json({ code: 0, ...await stageFeishuMeetingSummary(header.event_id ?? "", payload.event) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "飞书事件处理失败" }, { status: 400 });
  }
}
