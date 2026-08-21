import { ensureDatabase, getD1 } from "../../../../lib/database";
import { assertSameOrigin, requireAppUser } from "../../../../lib/feishu-auth";

type ImportRow = {
  id: number;
  message_id: string;
  message_type: string;
  extracted_text: string;
  detected_reason: string;
  status: "pending" | "confirmed" | "ignored";
  message_created_at: string;
  received_at: string;
};

type LinkRow = {
  id: number;
  import_id: number;
  student_id: string;
  student_name: string;
  progress_entry_id: number;
  created_at: string;
};

class InputError extends Error {}

function cleanText(value: unknown, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new InputError(`内容不能超过 ${maxLength} 个字符`);
  return text;
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const d1 = getD1();
    const imports = await d1.prepare(`SELECT id, message_id, message_type, extracted_text,
      detected_reason, status, message_created_at, received_at
      FROM feishu_meeting_summary_imports
      WHERE status != 'ignored'
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, message_created_at DESC
      LIMIT 60`).all<ImportRow>();
    const importIds = imports.results.map((item) => item.id);
    let links: LinkRow[] = [];
    if (importIds.length) {
      const placeholders = importIds.map(() => "?").join(",");
      const result = await d1.prepare(`SELECT l.id, l.import_id, l.student_id,
        s.display_name AS student_name, l.progress_entry_id, l.created_at
        FROM feishu_meeting_summary_links l JOIN students s ON s.id = l.student_id
        WHERE l.import_id IN (${placeholders}) ORDER BY l.created_at DESC`)
        .bind(...importIds).all<LinkRow>();
      links = result.results;
    }
    return Response.json({
      imports: imports.results.map((item) => ({
        ...item,
        links: links.filter((link) => link.import_id === item.id),
      })),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "会议总结读取失败" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  let createdProgressId: number | null = null;
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const importId = Number(body.importId);
    if (!Number.isInteger(importId)) return Response.json({ error: "会议总结参数无效" }, { status: 400 });
    const d1 = getD1();
    const source = await d1.prepare(`SELECT id, message_id, extracted_text, status
      FROM feishu_meeting_summary_imports WHERE id = ?`).bind(importId)
      .first<{ id: number; message_id: string; extracted_text: string; status: "pending" | "confirmed" | "ignored" }>();
    if (!source) return Response.json({ error: "会议总结不存在" }, { status: 404 });

    if (action === "ignore") {
      const linkCount = await d1.prepare("SELECT COUNT(*) AS count FROM feishu_meeting_summary_links WHERE import_id = ?")
        .bind(importId).first<{ count: number }>();
      if ((linkCount?.count ?? 0) > 0) return Response.json({ error: "已关联学生进展的总结不能忽略" }, { status: 409 });
      await d1.prepare(`UPDATE feishu_meeting_summary_imports SET status = 'ignored',
        chat_id = '', sender_id = '', sender_type = '', raw_content = '', extracted_text = '',
        reviewed_by_user_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(auth.user.id, importId).run();
      return Response.json({ message: "该候选已忽略，消息内容已清除" });
    }

    if (action !== "create_progress" || source.status === "ignored") {
      return Response.json({ error: "处理方式无效" }, { status: 400 });
    }
    const studentId = cleanText(body.studentId, 80);
    const title = cleanText(body.title, 160) || "AI 会议总结";
    if (!studentId) return Response.json({ error: "请选择关联学生" }, { status: 400 });
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
    if (!student) return Response.json({ error: "学生不存在或已停用" }, { status: 404 });
    const existing = await d1.prepare(`SELECT id FROM feishu_meeting_summary_links
      WHERE import_id = ? AND student_id = ?`).bind(importId, studentId).first();
    if (existing) return Response.json({ error: "该总结已经关联过这名学生" }, { status: 409 });

    const progress = await d1.prepare(`INSERT INTO progress_entries
      (student_id, kind, title, summary, evidence, status)
      VALUES (?, '组会', ?, ?, ?, 'pending') RETURNING id`)
      .bind(studentId, title, source.extracted_text, `飞书 AI 会议总结 · 消息 ${source.message_id.slice(-10)}`)
      .first<{ id: number }>();
    if (!progress?.id) throw new Error("无法建立进展草稿");
    createdProgressId = progress.id;
    await d1.batch([
      d1.prepare(`INSERT INTO feishu_meeting_summary_links
        (import_id, student_id, progress_entry_id) VALUES (?, ?, ?)`)
        .bind(importId, studentId, progress.id),
      d1.prepare(`UPDATE feishu_meeting_summary_imports SET status = 'confirmed',
        chat_id = '', sender_id = '', sender_type = '', raw_content = '',
        reviewed_by_user_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(auth.user.id, importId),
    ]);
    createdProgressId = null;
    return Response.json({ message: "已生成学生进展草稿，等待常规审核" });
  } catch (error) {
    if (createdProgressId) {
      try {
        await getD1().prepare("DELETE FROM progress_entries WHERE id = ? AND status = 'pending'")
          .bind(createdProgressId).run();
      } catch { /* 保留原始错误，遗留草稿可由管理员审核处理 */ }
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "会议总结处理失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}
