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

function shanghaiDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function stableMessageUuid(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const d1 = getD1();
    const scope = auth.user.role === "superadmin"
      ? ""
      : `WHERE EXISTS (SELECT 1 FROM mentor_student_assignments assignment
          WHERE assignment.mentor_user_id = ? AND assignment.student_id = d.student_id
            AND assignment.active = 1)`;
    const statement = d1.prepare(`SELECT d.id, d.student_id, s.display_name AS student_name,
      d.reason, d.status, d.error_message, d.sent_at, d.created_at
      FROM notification_deliveries d JOIN students s ON s.id = d.student_id
      ${scope} ORDER BY d.created_at DESC, d.id DESC LIMIT 100`);
    const deliveries = auth.user.role === "superadmin"
      ? await statement.all()
      : await statement.bind(auth.user.id).all();
    return Response.json({ deliveries: deliveries.results });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "提醒记录读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let deliveryId: number | null = null;
  let attemptToken = "";
  try {
    if (!assertSameOrigin(request)) {
      return Response.json({ error: "请求来源无效" }, { status: 403 });
    }
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    const body = (await request.json()) as { studentId?: string; reason?: string };
    const studentId = body.studentId?.trim() ?? "";
    const reason = body.reason?.trim() || "超过个性化进展周期，提醒补充下一步行动与证据";
    if (!studentId) return Response.json({ error: "缺少学生记录" }, { status: 400 });
    if (reason.length > 300) return Response.json({ error: "提醒原因不能超过 300 个字符" }, { status: 400 });

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

    const d1 = getD1();
    attemptToken = crypto.randomUUID();
    const idempotencyKey = `progress-reminder:${studentId}:${shanghaiDateKey()}`;
    const messageUuid = await stableMessageUuid(idempotencyKey);
    const existing = await d1.prepare(`SELECT id, status,
        CASE WHEN status = 'sending' AND updated_at <= datetime('now', '-10 minutes') THEN 1 ELSE 0 END AS retryable
      FROM notification_deliveries WHERE idempotency_key = ?`)
      .bind(idempotencyKey).first<{ id: number; status: string; retryable: number }>();
    if (existing?.status === "sent" || (existing?.status === "sending" && !existing.retryable)) {
      return Response.json({ error: "该学生今日已提醒，请勿重复发送" }, { status: 409 });
    }
    const delivery = existing
      ? await d1.prepare(`UPDATE notification_deliveries SET status = 'sending', reason = ?,
          error_message = '', attempt_token = ?, provider_message_id = '', updated_at = CURRENT_TIMESTAMP
          WHERE idempotency_key = ? AND (status = 'failed'
            OR (status = 'sending' AND updated_at <= datetime('now', '-10 minutes')))
          RETURNING id`)
        .bind(reason, attemptToken, idempotencyKey).first<{ id: number }>()
      : await d1.prepare(`INSERT INTO notification_deliveries
          (student_id, triggered_by_user_id, reason, idempotency_key, attempt_token, status)
          VALUES (?, ?, ?, ?, ?, 'sending')
          ON CONFLICT(idempotency_key) DO NOTHING RETURNING id`)
        .bind(studentId, auth.user.id, reason, idempotencyKey, attemptToken).first<{ id: number }>();
    deliveryId = delivery?.id ?? null;
    if (!deliveryId) return Response.json({ error: "该学生的提醒正在发送，请勿重复操作" }, { status: 409 });

    const appUrl = new URL(request.url).origin;
    const sent = await sendFeishuCard(recipient.feishu_open_id, {
      config: { wide_screen_mode: true },
      header: {
        template: "blue",
        title: { tag: "plain_text", content: "探研 · 进展更新提醒" },
      },
      elements: [
        {
          tag: "markdown",
          content: `**${recipient.display_name}**，请更新当前阶段的实质性进展。\n\n当前阶段：${recipient.stage}\n个性化周期：${recipient.cadence_days} 天\n提醒原因：${reason}`,
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
    }, messageUuid);
    const finalized = await d1.prepare(`UPDATE notification_deliveries SET status = 'sent', sent_at = CURRENT_TIMESTAMP,
      error_message = '', provider_message_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND attempt_token = ?`)
      .bind(sent.data?.message_id ?? "", deliveryId, attemptToken).run();
    if (!finalized.meta.changes) return Response.json({ error: "提醒发送状态已由新的重试接管" }, { status: 409 });
    return Response.json({ message: "飞书提醒已发送并记入提醒台账" });
  } catch (error) {
    if (deliveryId) {
      await getD1().prepare(`UPDATE notification_deliveries SET status = 'failed', error_message = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND attempt_token = ?`)
        .bind(error instanceof Error ? error.message.slice(0, 500) : "未知发送错误", deliveryId, attemptToken)
        .run().catch(() => undefined);
    }
    return Response.json({ error: error instanceof Error ? error.message : "提醒发送失败" }, { status: 502 });
  }
}
