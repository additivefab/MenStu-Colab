import { canViewStudent } from "../../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../../lib/database";
import { requireAppUser } from "../../../../lib/feishu-auth";
import { attachmentDisposition } from "../../../../lib/progress-attachments";
import { getProgressFileBucket } from "../../../../lib/progress-file-storage";

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1) return Response.json({ error: "附件参数无效" }, { status: 400 });
    const row = await getD1().prepare(`SELECT a.*, pr.student_id FROM progress_resolution_attachments a
      JOIN progress_resolution_events e ON e.id = a.event_id
      JOIN progress_resolutions pr ON pr.id = e.resolution_id
      JOIN progress_entries p ON p.id = pr.progress_entry_id AND p.student_id = pr.student_id
      WHERE a.id = ? AND NOT EXISTS (SELECT 1 FROM progress_deletions d WHERE d.progress_entry_id = p.id)`)
      .bind(id).first<{ storage_key: string; student_id: string; content_type: string; size_bytes: number; file_name: string; content_sha256: string }>();
    if (!row) return Response.json({ error: "附件不存在" }, { status: 404 });
    if (!(await canViewStudent(auth.user, row.student_id))) return Response.json({ error: "无权访问该附件" }, { status: 403 });
    const object = await getProgressFileBucket().get(row.storage_key);
    if (!object) return Response.json({ error: "附件文件不存在" }, { status: 404 });
    return new Response(object.body, { headers: {
      "Content-Type": row.content_type || "application/octet-stream", "Content-Length": String(row.size_bytes),
      "Content-Disposition": attachmentDisposition(row.file_name), "Cache-Control": "private, no-store", Vary: "Cookie",
      "X-Content-Type-Options": "nosniff", "X-File-SHA256": row.content_sha256,
    } });
  } catch {
    return Response.json({ error: "附件读取失败" }, { status: 500 });
  }
}
