import { ensureDatabase, getD1 } from "../../../lib/database";

const actions = new Set(["substantive", "supporting", "supplement", "rejected"]);

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const id = Number(body.id);
    const action = String(body.action ?? "");
    const note = String(body.note ?? "").trim();
    if (!Number.isInteger(id) || !actions.has(action)) {
      return Response.json({ error: "审核参数无效" }, { status: 400 });
    }

    const d1 = getD1();
    const entry = await d1.prepare("SELECT student_id FROM progress_entries WHERE id = ? AND status = 'pending'").bind(id).first<{ student_id: string }>();
    if (!entry) return Response.json({ error: "记录不存在或已审核" }, { status: 404 });

    const statements = [
      d1.prepare(`UPDATE progress_entries SET status = ?, reviewer_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(action, note, id),
    ];
    if (action === "substantive") {
      statements.push(
        d1.prepare("UPDATE students SET last_substantive_at = CURRENT_TIMESTAMP WHERE id = ?").bind(entry.student_id),
      );
    }
    await d1.batch(statements);
    return Response.json({ message: "审核已保存" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "审核失败" }, { status: 500 });
  }
}
