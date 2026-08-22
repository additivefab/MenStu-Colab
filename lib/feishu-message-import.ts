import { ensureDatabase, getD1 } from "./database";
import { detectMeetingSummary, extractFeishuMessageText } from "./feishu-events";
import { splitMeetingProgressByStudent } from "./feishu-progress-extraction";
import { sha256Text } from "./progress-evidence";

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

function sourceType(value: string) {
  if (/\/minutes\//iu.test(value)) return "feishu_minutes";
  if (/\/docx\//iu.test(value)) return "feishu_docx";
  return "feishu_message";
}

function sourceLabel(value: string) {
  const type = sourceType(value);
  if (type === "feishu_minutes") return "飞书妙记导入";
  if (type === "feishu_docx") return "飞书智能纪要文档导入";
  return "飞书智能纪要导入";
}

async function autoCreateStudentProgress(importId: number, extractedText: string, sourceText: string) {
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
    if (existing) {
      linkedNames.push(draft.studentName);
      continue;
    }

    const evidence = `飞书智能纪要自动拆分 · 识别学生 ${draft.studentName}`;
    let progressId: number | null = null;
    try {
      const progress = await d1.prepare(`INSERT INTO progress_entries
        (student_id, kind, title, summary, evidence, status, review_status, updated_at)
        VALUES (?, '组会', ?, ?, ?, 'pending', 'submitted', CURRENT_TIMESTAMP) RETURNING id`)
        .bind(draft.studentId, draft.title, draft.summary, evidence)
        .first<{ id: number }>();
      progressId = progress?.id ?? null;
      if (!progressId) throw new Error("无法生成学生个人进展");
      await d1.batch([
        d1.prepare(`INSERT INTO feishu_meeting_summary_links
          (import_id, student_id, progress_entry_id) VALUES (?, ?, ?)`)
          .bind(importId, draft.studentId, progressId),
        d1.prepare(`INSERT INTO progress_evidence_sources
          (progress_entry_id, source_type, label, source_ref, source_import_id, content_sha256, occurred_at)
          VALUES (?, ?, ?, '', ?, ?, CURRENT_TIMESTAMP)`)
          .bind(progressId, sourceType(sourceText), sourceLabel(sourceText), importId, await sha256Text(draft.summary)),
        d1.prepare(`INSERT INTO progress_audit_events
          (progress_entry_id, actor_type, action, from_status, to_status, note)
          VALUES (?, 'feishu', 'auto_import', '', 'submitted', '归属明确，自动生成个人待审核进展')`)
          .bind(progressId),
      ]);
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
  if (source.status === "confirmed") {
    return { staged: false, filtered: false, autoAssigned: true, studentNames: [] as string[] };
  }
  const automatic = await autoCreateStudentProgress(
    source.id,
    extractedText,
    `${rawContent}\n${extractedText}`,
  );
  return {
    staged: (result.meta.changes ?? 0) > 0,
    filtered: false,
    ...automatic,
  };
}
