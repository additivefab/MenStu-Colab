import { confirmedRoster } from "../../../../lib/confirmed-roster";
import {
  CURRENT_SCHEMA_VERSION,
  ensureDatabase,
  getD1,
  getDatabaseSchemaStatus,
} from "../../../../lib/database";
import { getFeishuConfig, isFeishuConfigured } from "../../../../lib/feishu-auth";
import { isProgressFileStorageConfigured } from "../../../../lib/progress-file-storage";

type ReadinessCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warning" | "manual";
  detail: string;
};

function response(payload: Record<string, unknown>, status: number) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET() {
  try {
    await ensureDatabase();
    const d1 = getD1();
    const [schema, students, bindings, users, cleanup] = await Promise.all([
      getDatabaseSchemaStatus(),
      d1.prepare(`SELECT id, display_name, degree, grade_year
        FROM students WHERE active = 1 ORDER BY id`).all<{
          id: string;
          display_name: string;
          degree: "博士" | "硕士";
          grade_year: number;
        }>(),
      d1.prepare(`SELECT COUNT(*) AS count FROM students s WHERE s.active = 1 AND (
        EXISTS (SELECT 1 FROM student_feishu_identity_bindings b WHERE b.student_id = s.id AND b.active = 1)
        OR EXISTS (SELECT 1 FROM local_credentials c JOIN app_users u ON u.id = c.app_user_id
          WHERE c.student_id = s.id AND u.student_id = s.id AND u.role = 'student'
            AND u.active = 1 AND c.password_hash IS NOT NULL)
      )`).first<{ count: number }>(),
      d1.prepare(`SELECT
        SUM(CASE WHEN active = 1 AND role = 'superadmin' THEN 1 ELSE 0 END) AS superadmins,
        SUM(CASE WHEN active = 1 AND role IN ('superadmin', 'mentor') THEN 1 ELSE 0 END) AS staff,
        SUM(CASE WHEN active = 1 AND role = 'student' AND student_id IS NOT NULL THEN 1 ELSE 0 END) AS student_logins
        FROM app_users`).first<{ superadmins: number; staff: number; student_logins: number }>(),
      d1.prepare(`SELECT COUNT(*) AS count FROM progress_file_cleanup_queue
        WHERE reason != 'upload_intent' OR updated_at <= datetime('now', '-30 minutes')`)
        .first<{ count: number }>(),
    ]);

    const activeStudents = students.results;
    const byId = new Map(activeStudents.map((student) => [student.id, student]));
    const rosterExact = activeStudents.length === confirmedRoster.length
      && confirmedRoster.every((student) => {
        const row = byId.get(student.id);
        return row?.display_name === student.name
          && row.degree === student.degree
          && Number(row.grade_year) === student.gradeYear;
      });
    const bindingCount = Number(bindings?.count ?? 0);
    const superadminCount = Number(users?.superadmins ?? 0);
    const staffCount = Number(users?.staff ?? 0);
    const studentLoginCount = Number(users?.student_logins ?? 0);
    const cleanupCount = Number(cleanup?.count ?? 0);
    const feishu = getFeishuConfig();

    const checks: ReadinessCheck[] = [
      {
        id: "schema",
        label: "数据库结构",
        status: schema.version === CURRENT_SCHEMA_VERSION && !schema.missingTables.length ? "pass" : "fail",
        detail: schema.missingTables.length
          ? `缺少 ${schema.missingTables.length} 张核心表`
          : `schema v${schema.version ?? "未记录"} / 期望 v${CURRENT_SCHEMA_VERSION}`,
      },
      {
        id: "roster",
        label: "真实学生名册",
        status: rosterExact ? "pass" : "fail",
        detail: rosterExact ? "26 人名册完整（12 博士、14 硕士）" : `当前有效档案 ${activeStudents.length} 人，需重新核对名册`,
      },
      {
        id: "identity_bindings",
        label: "学生登录账号关联",
        status: bindingCount === confirmedRoster.length ? "pass" : "fail",
        detail: `已预绑定飞书身份或启用独立账号 ${bindingCount} / ${confirmedRoster.length} 人；实际登录需本人验收`,
      },
      {
        id: "feishu",
        label: "飞书应用配置",
        status: isFeishuConfigured() ? "pass" : "warning",
        detail: isFeishuConfigured()
          ? `登录凭据已配置；事件验签${feishu.encryptKey || feishu.verificationToken ? "已配置" : "仍需核验"}`
          : "飞书登录与集成未配置；已开通的独立学生账号可正常登录",
      },
      {
        id: "file_storage",
        label: "附件对象存储",
        status: isProgressFileStorageConfigured() ? "pass" : "fail",
        detail: isProgressFileStorageConfigured() ? "R2 绑定 FILES 可用" : "R2 绑定 FILES 不可用",
      },
      {
        id: "file_cleanup_queue",
        label: "附件补偿清理",
        status: cleanupCount ? "warning" : "pass",
        detail: cleanupCount ? `有 ${cleanupCount} 个对象等待后台重试清理` : "没有待清理的孤儿对象",
      },
      {
        id: "operators",
        label: "管理账号",
        status: superadminCount === 1 && staffCount >= 1 ? "pass" : "fail",
        detail: `超级管理员 ${superadminCount} 人 · 管理人员 ${staffCount} 人`,
      },
      {
        id: "student_smoke_test",
        label: "真实学生首登",
        status: studentLoginCount >= 2 ? "pass" : "warning",
        detail: `已产生 ${studentLoginCount} 个已绑定学生登录；上线前至少验收 1 博士 + 1 硕士`,
      },
      {
        id: "mainland_networks",
        label: "大陆三网访问",
        status: "manual",
        detail: "需在校园网、家庭宽带、手机流量分别实测登录、提交与下载",
      },
      {
        id: "backup_restore",
        label: "备份恢复演练",
        status: "manual",
        detail: "需完成 D1 与 R2 全量备份、校验和恢复演练",
      },
    ];
    const blocking = checks.filter((check) => check.status === "fail");
    return response({
      ready: blocking.length === 0,
      generated_at: new Date().toISOString(),
      checks,
      summary: {
        blocking: blocking.length,
        warnings: checks.filter((check) => check.status === "warning").length,
        manual: checks.filter((check) => check.status === "manual").length,
      },
    }, blocking.length ? 503 : 200);
  } catch (error) {
    console.error("Production readiness probe failed", error);
    return response({
      ready: false,
      generated_at: new Date().toISOString(),
      checks: [{
        id: "database",
        label: "数据库连接与升级",
        status: "fail",
        detail: "数据库不可用或 schema 升级未完成",
      } satisfies ReadinessCheck],
      summary: { blocking: 1, warnings: 0, manual: 2 },
    }, 503);
  }
}
