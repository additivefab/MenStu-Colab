import { ensureDatabase, getD1 } from "../../../../lib/database";
import { canViewStudent } from "../../../../lib/authorization";
import {
  assertSameOrigin,
  requireAppUser,
  sendFeishuCard,
} from "../../../../lib/feishu-auth";

type RecipientRow = {
  feishu_open_id: string;
  display_name: string;
  cadence_days: number;
  stage: string;
};

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) {
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    }
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    const body = (await request.json()) as { studentId?: string };
    const studentId = body.studentId?.trim() ?? "";
    if (!studentId) return Response.json({ error: "缺少学生记录" }, { status: 400 });

    await ensureDatabase();
    if (!(await canViewStudent(auth.user, studentId))) {
      return Response.json({ error: "当前账号无权访问该学生" }, { status: 403 });
    }
    const recipient = await getD1().prepare(`SELECT
      u.feishu_open_id, s.display_name, s.cadence_days, s.stage
      FROM app_users u JOIN students s ON s.id = u.student_id
      WHERE u.student_id = ? AND u.role = 'student' AND u.active = 1`)
      .bind(studentId)
      .first<RecipientRow>();
    if (!recipient) {
      return Response.json({ error: "该学生尚未绑定飞书账号" }, { status: 409 });
    }

    const appUrl = new URL(request.url).origin;
    await sendFeishuCard(recipient.feishu_open_id, {
      config: { wide_screen_mode: true },
      header: {
        template: "blue",
        title: { tag: "plain_text", content: "探研 · 进展更新提醒" },
      },
      elements: [
        {
          tag: "markdown",
          content: `**${recipient.display_name}**，请更新当前阶段的实质性进展。\n\n当前阶段：${recipient.stage}\n个性化周期：${recipient.cadence_days} 天`,
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "提交进展" },
              type: "primary",
              url: appUrl,
            },
          ],
        },
        { tag: "note", elements: [{ tag: "plain_text", content: "阅读论文也计入进展，但需提交论文信息、结论和证据。" }] },
      ],
    });
    return Response.json({ message: "飞书提醒已发送" });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "提醒发送失败" }, { status: 502 });
  }
}
