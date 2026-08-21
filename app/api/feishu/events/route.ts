import { ensureDatabase, getD1 } from "../../../../lib/database";
import { getFeishuConfig } from "../../../../lib/feishu-auth";
import { detectMeetingSummary, extractFeishuMessageText, parseFeishuEvent, secureTextEqual } from "../../../../lib/feishu-events";

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

function isoFromMilliseconds(value: string | undefined) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : new Date().toISOString();
}

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

    const message = payload.event?.message;
    if (!header.event_id || !message?.message_id || !message.chat_id || message.chat_type !== "group") {
      return Response.json({ code: 0 });
    }
    const rawContent = typeof message.content === "string" ? message.content : "";
    const extractedText = extractFeishuMessageText(rawContent);
    const detectedReason = detectMeetingSummary(extractedText);
    if (!detectedReason) return Response.json({ code: 0, filtered: true });

    const senderIds = payload.event?.sender?.sender_id;
    const senderId = senderIds?.open_id ?? senderIds?.user_id ?? senderIds?.app_id ?? senderIds?.union_id ?? "";
    await ensureDatabase();
    await getD1().prepare(`INSERT OR IGNORE INTO feishu_meeting_summary_imports
      (event_id, message_id, chat_id, sender_id, sender_type, message_type,
       raw_content, extracted_text, detected_reason, message_created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        header.event_id,
        message.message_id,
        message.chat_id,
        senderId,
        payload.event?.sender?.sender_type ?? "",
        message.message_type ?? "",
        rawContent,
        extractedText,
        detectedReason,
        isoFromMilliseconds(message.create_time),
      )
      .run();
    return Response.json({ code: 0 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "飞书事件处理失败" }, { status: 400 });
  }
}
