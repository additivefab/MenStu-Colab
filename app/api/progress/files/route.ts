import { canViewStudent } from "../../../../lib/authorization";
import { ensureDatabase, getD1 } from "../../../../lib/database";
import { requireAppUser } from "../../../../lib/feishu-auth";
import { attachmentDisposition } from "../../../../lib/progress-attachments";
import { getProgressFileBucket } from "../../../../lib/progress-file-storage";

type AttachmentRow = {
  id: number;
  student_id: string;
  storage_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  content_sha256: string;
};

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin", "student"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();

    const id = Number(new URL(request.url).searchParams.get("id"));
    if (!Number.isInteger(id) || id < 1) {
      return Response.json({ error: "附件参数无效" }, { status: 400 });
    }

    const row = await getD1().prepare(`SELECT a.id, p.student_id, a.storage_key, a.file_name,
      a.content_type, a.size_bytes, a.content_sha256
      FROM progress_attachments a
      JOIN progress_entries p ON p.id = a.progress_entry_id
      WHERE a.id = ?`).bind(id).first<AttachmentRow>();
    if (!row) return Response.json({ error: "附件不存在" }, { status: 404 });
    if (!(await canViewStudent(auth.user, row.student_id))) {
      return Response.json({ error: "无权访问该附件" }, { status: 403 });
    }

    const object = await getProgressFileBucket().get(row.storage_key);
    if (!object) return Response.json({ error: "附件文件不存在" }, { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": row.content_type || "application/octet-stream",
        "Content-Length": String(row.size_bytes),
        "Content-Disposition": attachmentDisposition(row.file_name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-File-SHA256": row.content_sha256,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "附件读取失败" },
      { status: 500 },
    );
  }
}
