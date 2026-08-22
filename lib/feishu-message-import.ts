import { ensureDatabase, getD1 } from "./database";
import { detectMeetingSummary, extractFeishuMessageText } from "./feishu-events";
import { splitMeetingProgressByStudent } from "./feishu-progress-extraction";

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

async function autoCreateStudentProgress(importId: number, messageId: string, extractedText: string) {
  const d1 = getD1();
  const students = await d1.prepare("SELECT id, display_name FROM students WHERE active = 1")
    .all<{ id: string; display_name: string }>();
  const drafts = splitMeetingProgressByStudent(
    extractedText,
    students.results.map((student) => ({ id: student.id, displayName: student.display_name })),
  );
  if (!drafts.length) return { autoAssigned: false, studentNames: [] as string[] };

  const linkedNames: string[] = [];
  for (const draft of drafts) {
    const existing = await d1.prepare(`SELECT progress_entry_id FROM feishu_meeting_summary_links
      WHERE import_id = ? AND student_id = ?`).bind(importId, draft.studentId)
      .first<{ progress_entry_id: number }>();
    const evidence = `飞书智能纪要自动拆分 · 识别学生 ${draft.studentName} · 消息 ${messageId.slice(-10)}`;
    if (existing) {
      await d1.prepare(`UPDATE progress_entries SET title = ?, summary = ?, evidence = ?
        WHERE id = ? AND student_id = ? AND status = 'pending'`)
        .bind(draft.title, draft.summary, evidence, existing.progress_entry_id, draft.studentId).run();
      linkedNames.push(draft.studentName);
      continue;
    }

    let progressId: number | null = null;
    try {
      const progress = await d1.prepare(`INSERT INTO progress_entries
        (student_id, kind, title, summary, evidence, status)
        VALUES (?, '组会', ?, ?, ?, 'pending') RETURNING id`)
        .bind(draft.studentId, draft.title, draft.summary, evidence)
        .first<{ id: number }>();
      progressId = progress?.id ?? null;
      if (!progressId) throw new Error("无法生成学生个人进展");
      await d1.prepare(`INSERT INTO feishu_meeting_summary_links
        (import_id, student_id, progress_entry_id) VALUES (?, ?, ?)`)
        .bind(importId, draft.studentId, progressId).run();
      linkedNames.push(draft.studentName);
      progressId = null;
    } catch (error) {
      if (progressId) {
        await d1.prepare("DELETE FROM progress_entries WHERE id = ? AND status = 'pending'").bind(progressId).run();
      }
      throw error;
    }
  }

  if (linkedNames.length) {
    await d1.prepare(`UPDATE feishu_meeting_summary_imports SET status = 'confirmed',
      chat_id = '', sender_id = '', sender_type = '', raw_content = '',
      reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP) WHERE id = ?`)
      .bind(importId).run();
  }
  return { autoAssigned: linkedNames.length > 0, studentNames: linkedNames };
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
  const d1 = getD1();
  const result = await d1.prepare(`INSERT OR IGNORE INTO feishu_meeting_summary_imports
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

  const source = await d1.prepare(`SELECT id, status FROM feishu_meeting_summary_imports
    WHERE message_id = ?`).bind(message.message_id)
    .first<{ id: number; status: "pending" | "confirmed" | "ignored" }>();
  if (!source || source.status === "ignored") {
    return { staged: (result.meta.changes ?? 0) > 0, filtered: false, autoAssigned: false };
  }
  const automatic = await autoCreateStudentProgress(source.id, message.message_id, extractedText);
  return {
    staged: (result.meta.changes ?? 0) > 0,
    filtered: false,
    ...automatic,
  };
}
