import { ensureDatabase, getD1 } from "./database";
import { detectMeetingSummary, extractFeishuMessageText } from "./feishu-events";

export type FeishuMessageEvent = {
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

function isoFromMilliseconds(value: string | undefined) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : new Date().toISOString();
}

export async function stageFeishuMeetingSummary(eventId: string, event: FeishuMessageEvent | undefined) {
  const message = event?.message;
  if (!eventId || !message?.message_id || !message.chat_id || message.chat_type !== "group") {
    return { staged: false, filtered: true };
  }

  const rawContent = typeof message.content === "string" ? message.content : "";
  const extractedText = extractFeishuMessageText(rawContent);
  const detectedReason = detectMeetingSummary(extractedText);
  if (!detectedReason) return { staged: false, filtered: true };

  const senderIds = event?.sender?.sender_id;
  const senderId = senderIds?.open_id ?? senderIds?.user_id ?? senderIds?.app_id ?? senderIds?.union_id ?? "";
  await ensureDatabase();
  const result = await getD1().prepare(`INSERT OR IGNORE INTO feishu_meeting_summary_imports
    (event_id, message_id, chat_id, sender_id, sender_type, message_type,
     raw_content, extracted_text, detected_reason, message_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      eventId,
      message.message_id,
      message.chat_id,
      senderId,
      event?.sender?.sender_type ?? "",
      message.message_type ?? "",
      rawContent,
      extractedText,
      detectedReason,
      isoFromMilliseconds(message.create_time),
    )
    .run();

  return { staged: (result.meta.changes ?? 0) > 0, filtered: false };
}
