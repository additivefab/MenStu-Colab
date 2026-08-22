import { ensureDatabase, getD1 } from "../../../lib/database";
import { canReviewStudent, canViewStudent, getStudentScope, scopeSql } from "../../../lib/authorization";
import { assertSameOrigin, isReviewerRole, requireAppUser } from "../../../lib/feishu-auth";
import type { AppUser } from "../../../lib/feishu-auth";

type ProposalStatus = "draft" | "submitted" | "changes_requested" | "approved";
type MilestoneStatus = "pending" | "in_progress" | "completed" | "blocked";

type ProposalRow = {
  id: number;
  student_id: string;
  student_name: string;
  degree: "博士" | "硕士";
  grade_year: number;
  title: string;
  scientific_question: string;
  hypothesis: string;
  objectives: string;
  innovation: string;
  literature_basis: string;
  methodology: string;
  data_ethics: string;
  risks: string;
  resources: string;
  references_text: string;
  status: ProposalStatus;
  current_version: number;
  reviewer_note: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  latest_submitted_by_user_id: number | null;
};

type MilestoneRow = {
  id: number;
  proposal_id: number;
  title: string;
  target_date: string;
  evidence_target: string;
  status: MilestoneStatus;
  sort_order: number;
  updated_at: string;
};

type VersionRow = {
  id: number;
  proposal_id: number;
  version_number: number;
  created_at: string;
  submitted_by_name: string;
};

type AuditRow = {
  id: number;
  proposal_id: number;
  action: string;
  detail: string;
  created_at: string;
  actor_name: string;
};

type MilestoneInput = {
  title: string;
  targetDate: string;
  evidenceTarget: string;
  status: MilestoneStatus;
  sortOrder: number;
};

const proposalStatuses = new Set<ProposalStatus>(["draft", "submitted", "changes_requested", "approved"]);
const milestoneStatuses = new Set<MilestoneStatus>(["pending", "in_progress", "completed", "blocked"]);

class InputError extends Error {}

function cleanText(value: unknown, label: string, maxLength: number) {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new InputError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function proposalInput(body: Record<string, unknown>) {
  return {
    title: cleanText(body.title, "方案题目", 200),
    scientificQuestion: cleanText(body.scientificQuestion, "科学问题", 3000),
    hypothesis: cleanText(body.hypothesis, "研究假设", 3000),
    objectives: cleanText(body.objectives, "研究目标", 5000),
    innovation: cleanText(body.innovation, "创新点", 3000),
    literatureBasis: cleanText(body.literatureBasis, "文献依据", 8000),
    methodology: cleanText(body.methodology, "技术路线", 8000),
    dataEthics: cleanText(body.dataEthics, "数据与伦理", 3000),
    risks: cleanText(body.risks, "风险与备选方案", 5000),
    resources: cleanText(body.resources, "资源需求", 3000),
    referencesText: cleanText(body.referencesText, "参考文献", 8000),
  };
}

function milestoneInput(value: unknown): MilestoneInput[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 12) throw new InputError("培养节点最多设置 12 项");
  return value.map((item, index) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const title = cleanText(row.title, `第 ${index + 1} 个节点`, 160);
    const targetDate = cleanText(row.targetDate, `第 ${index + 1} 个节点日期`, 10);
    const evidenceTarget = cleanText(row.evidenceTarget, `第 ${index + 1} 个节点证据`, 800);
    const status = String(row.status ?? "pending") as MilestoneStatus;
    if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) throw new InputError(`第 ${index + 1} 个节点日期格式无效`);
    if (!milestoneStatuses.has(status)) throw new InputError(`第 ${index + 1} 个节点状态无效`);
    return { title, targetDate, evidenceTarget, status, sortOrder: index };
  }).filter((item) => item.title || item.targetDate || item.evidenceTarget);
}

function validateSubmission(fields: ReturnType<typeof proposalInput>, milestones: MilestoneInput[]) {
  const missing = [
    ["方案题目", fields.title],
    ["科学问题", fields.scientificQuestion],
    ["研究目标", fields.objectives],
    ["文献依据", fields.literatureBasis],
    ["技术路线", fields.methodology],
    ["风险与备选方案", fields.risks],
  ].filter(([, value]) => !value).map(([label]) => label);
  if (missing.length) throw new InputError(`正式提交前请补充：${missing.join("、")}`);
  if (!milestones.length) throw new InputError("正式提交前至少设置一个培养节点");
  const incomplete = milestones.findIndex((item) => !item.title || !item.targetDate || !item.evidenceTarget);
  if (incomplete >= 0) throw new InputError(`请完整填写第 ${incomplete + 1} 个培养节点的名称、日期和验收证据`);
}

async function readProposals(user: AppUser) {
  const d1 = getD1();
  const scope = await getStudentScope(user);
  const proposalScope = scopeSql(scope, "rp.student_id");
  const statement = d1.prepare(`SELECT rp.*, s.display_name AS student_name, s.degree, s.grade_year,
    (SELECT v.submitted_by_user_id FROM research_proposal_versions v
      WHERE v.proposal_id = rp.id ORDER BY v.version_number DESC LIMIT 1) AS latest_submitted_by_user_id
    FROM research_proposals rp
    JOIN students s ON s.id = rp.student_id
    WHERE s.active = 1${proposalScope.clause}
    ORDER BY CASE rp.status WHEN 'submitted' THEN 0 WHEN 'changes_requested' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
      rp.updated_at DESC`);
  const result = proposalScope.bindings.length
    ? await statement.bind(...proposalScope.bindings).all<ProposalRow>()
    : await statement.all<ProposalRow>();
  const proposalIds = result.results.map((item) => item.id);
  if (!proposalIds.length) return [];

  const placeholders = proposalIds.map(() => "?").join(",");
  const [milestoneResult, versionResult, auditResult] = await Promise.all([
    d1.prepare(`SELECT id, proposal_id, title, target_date, evidence_target, status, sort_order, updated_at
      FROM research_milestones WHERE proposal_id IN (${placeholders})
      ORDER BY proposal_id, sort_order, target_date`).bind(...proposalIds).all<MilestoneRow>(),
    d1.prepare(`SELECT v.id, v.proposal_id, v.version_number, v.created_at,
      u.display_name AS submitted_by_name
      FROM research_proposal_versions v JOIN app_users u ON u.id = v.submitted_by_user_id
      WHERE v.proposal_id IN (${placeholders}) ORDER BY v.proposal_id, v.version_number DESC`)
      .bind(...proposalIds).all<VersionRow>(),
    d1.prepare(`SELECT a.id, a.proposal_id, a.action, a.detail, a.created_at,
      u.display_name AS actor_name
      FROM proposal_audit_events a JOIN app_users u ON u.id = a.actor_user_id
      WHERE a.proposal_id IN (${placeholders}) ORDER BY a.proposal_id, a.created_at DESC`)
      .bind(...proposalIds).all<AuditRow>(),
  ]);

  return Promise.all(result.results.map(async (proposal) => ({
    ...proposal,
    can_review: isReviewerRole(user.role)
      && proposal.latest_submitted_by_user_id !== user.id
      && await canReviewStudent(user, proposal.student_id),
    milestones: milestoneResult.results.filter((item) => item.proposal_id === proposal.id),
    versions: versionResult.results.filter((item) => item.proposal_id === proposal.id),
    audit: auditResult.results.filter((item) => item.proposal_id === proposal.id).slice(0, 20),
  })));
}

export async function GET(request: Request) {
  try {
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    if (auth.user.role === "student" && !auth.user.studentId) {
      return Response.json({ error: "飞书账号尚未绑定学生记录" }, { status: 403 });
    }
    await ensureDatabase();
    const proposals = await readProposals(auth.user);
    return Response.json({ proposals });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "研究方案读取失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const mode = String(body.mode ?? "draft");
    if (mode !== "draft" && mode !== "submit") return Response.json({ error: "保存方式无效" }, { status: 400 });
    const studentId = cleanText(body.studentId, "学生", 80);
    if (!studentId) return Response.json({ error: "请选择学生" }, { status: 400 });

    const fields = proposalInput(body);
    const milestones = milestoneInput(body.milestones);
    if (mode === "submit") validateSubmission(fields, milestones);
    const d1 = getD1();
    if (!(await canViewStudent(auth.user, studentId))) {
      return Response.json({ error: "当前账号无权为该学生维护研究方案" }, { status: 403 });
    }
    const student = await d1.prepare("SELECT id FROM students WHERE id = ? AND active = 1").bind(studentId).first();
    if (!student) return Response.json({ error: "学生不存在或已停用" }, { status: 404 });

    let proposal = await d1.prepare(`SELECT id, status, current_version, reviewer_note
      FROM research_proposals WHERE student_id = ?`).bind(studentId)
      .first<{ id: number; status: ProposalStatus; current_version: number; reviewer_note: string }>();
    if (proposal && !proposalStatuses.has(proposal.status)) return Response.json({ error: "方案状态无效" }, { status: 409 });
    if (proposal?.status === "submitted") return Response.json({ error: "方案正在审核，暂时不能修改" }, { status: 409 });
    if (proposal?.status === "approved") return Response.json({ error: "已确认方案已冻结；重大调整需由管理员退回后形成新版本" }, { status: 409 });

    if (!proposal) {
      proposal = await d1.prepare(`INSERT INTO research_proposals
        (student_id, title, created_by_user_id) VALUES (?, ?, ?)
        RETURNING id, status, current_version, reviewer_note`)
        .bind(studentId, fields.title || "未命名方案", auth.user.id)
        .first<{ id: number; status: ProposalStatus; current_version: number; reviewer_note: string }>();
    }
    if (!proposal) throw new Error("无法建立研究方案记录");

    const nextVersion = mode === "submit" ? proposal.current_version + 1 : proposal.current_version;
    const nextStatus: ProposalStatus = mode === "submit"
      ? "submitted"
      : proposal.status === "changes_requested" ? "changes_requested" : "draft";
    const statements = [
      d1.prepare(`UPDATE research_proposals SET
        title = ?, scientific_question = ?, hypothesis = ?, objectives = ?, innovation = ?,
        literature_basis = ?, methodology = ?, data_ethics = ?, risks = ?, resources = ?,
        references_text = ?, status = ?, current_version = ?, reviewer_note = ?,
        updated_at = CURRENT_TIMESTAMP,
        submitted_at = CASE WHEN ? = 'submitted' THEN CURRENT_TIMESTAMP ELSE submitted_at END,
        approved_at = NULL
        WHERE id = ?`)
        .bind(
          fields.title || "未命名方案", fields.scientificQuestion, fields.hypothesis,
          fields.objectives, fields.innovation, fields.literatureBasis, fields.methodology,
          fields.dataEthics, fields.risks, fields.resources, fields.referencesText,
          nextStatus, nextVersion, mode === "submit" ? "" : proposal.reviewer_note,
          nextStatus, proposal.id,
        ),
      d1.prepare("DELETE FROM research_milestones WHERE proposal_id = ?").bind(proposal.id),
      ...milestones.map((milestone) =>
        d1.prepare(`INSERT INTO research_milestones
          (proposal_id, title, target_date, evidence_target, status, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(proposal!.id, milestone.title, milestone.targetDate, milestone.evidenceTarget, milestone.status, milestone.sortOrder),
      ),
      d1.prepare(`INSERT INTO proposal_audit_events (proposal_id, actor_user_id, action, detail)
        VALUES (?, ?, ?, ?)`)
        .bind(proposal.id, auth.user.id, mode === "submit" ? "submit" : "save_draft", mode === "submit" ? `提交第 ${nextVersion} 版` : "保存草稿"),
    ];
    if (mode === "submit") {
      statements.push(
        d1.prepare(`INSERT INTO research_proposal_versions
          (proposal_id, version_number, snapshot_json, submitted_by_user_id)
          VALUES (?, ?, ?, ?)`)
          .bind(proposal.id, nextVersion, JSON.stringify({ ...fields, milestones }), auth.user.id),
      );
    }
    await d1.batch(statements);
    return Response.json({
      id: proposal.id,
      status: nextStatus,
      version: nextVersion,
      message: mode === "submit" ? `第 ${nextVersion} 版已提交导师审核` : "草稿已保存",
    }, { status: proposal.current_version === 0 && mode === "draft" ? 201 : 200 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "研究方案保存失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    if (!assertSameOrigin(request)) return Response.json({ error: "请求来源无效" }, { status: 403 });
    const auth = await requireAppUser(request, ["superadmin", "admin"]);
    if ("response" in auth) return auth.response;
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const d1 = getD1();

    if (action === "update_milestone") {
      const milestoneId = Number(body.milestoneId);
      const status = String(body.status ?? "") as MilestoneStatus;
      if (!Number.isInteger(milestoneId) || !milestoneStatuses.has(status)) {
        return Response.json({ error: "节点更新参数无效" }, { status: 400 });
      }
      const milestone = await d1.prepare(`SELECT m.id, m.proposal_id, m.title, p.student_id, p.status AS proposal_status
        FROM research_milestones m JOIN research_proposals p ON p.id = m.proposal_id
        WHERE m.id = ?`).bind(milestoneId)
        .first<{ id: number; proposal_id: number; title: string; student_id: string; proposal_status: ProposalStatus }>();
      if (!milestone) return Response.json({ error: "培养节点不存在" }, { status: 404 });
      if (!(await canViewStudent(auth.user, milestone.student_id))) {
        return Response.json({ error: "无权更新该学生的培养节点" }, { status: 403 });
      }
      if (milestone.proposal_status !== "approved") {
        return Response.json({ error: "方案确认后才能更新培养节点执行状态" }, { status: 409 });
      }
      await d1.batch([
        d1.prepare("UPDATE research_milestones SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(status, milestone.id),
        d1.prepare(`INSERT INTO proposal_audit_events (proposal_id, actor_user_id, action, detail)
          VALUES (?, ?, 'milestone_update', ?)`)
          .bind(milestone.proposal_id, auth.user.id, `${milestone.title} → ${status}`),
      ]);
      return Response.json({ message: "培养节点状态已更新" });
    }

    if (!isReviewerRole(auth.user.role)) return Response.json({ error: "只有授权管理员或超级管理员可以审核研究方案" }, { status: 403 });
    if (!new Set(["approve", "request_changes", "reopen"]).has(action)) {
      return Response.json({ error: "审核操作无效" }, { status: 400 });
    }
    const proposalId = Number(body.proposalId);
    const note = cleanText(body.note, "导师意见", 3000);
    if (!Number.isInteger(proposalId)) return Response.json({ error: "研究方案参数无效" }, { status: 400 });
    if ((action === "request_changes" || action === "reopen") && !note) {
      return Response.json({ error: "退回或重开方案时必须填写具体意见" }, { status: 400 });
    }
    const proposal = await d1.prepare(`SELECT rp.id, rp.student_id, rp.status, rp.current_version,
      (SELECT v.submitted_by_user_id FROM research_proposal_versions v
        WHERE v.proposal_id = rp.id ORDER BY v.version_number DESC LIMIT 1) AS latest_submitted_by_user_id
      FROM research_proposals rp WHERE rp.id = ?`)
      .bind(proposalId).first<{
        id: number;
        student_id: string;
        status: ProposalStatus;
        current_version: number;
        latest_submitted_by_user_id: number | null;
      }>();
    if (!proposal) return Response.json({ error: "研究方案不存在" }, { status: 404 });
    if (!(await canReviewStudent(auth.user, proposal.student_id))) {
      return Response.json({ error: "当前账号无权审核该学生" }, { status: 403 });
    }
    if (proposal.latest_submitted_by_user_id === auth.user.id) {
      return Response.json({ error: "不能审核由自己提交的研究方案版本" }, { status: 403 });
    }
    if (action !== "reopen" && proposal.status !== "submitted") {
      return Response.json({ error: "只有待审核方案可以执行该操作" }, { status: 409 });
    }
    if (action === "reopen" && proposal.status !== "approved") {
      return Response.json({ error: "只有已确认方案可以重开修订" }, { status: 409 });
    }

    const nextStatus: ProposalStatus = action === "approve" ? "approved" : "changes_requested";
    const detail = note || `确认第 ${proposal.current_version} 版`;
    const [updateResult] = await d1.batch([
      d1.prepare(`UPDATE research_proposals SET status = ?, reviewer_note = ?, updated_at = CURRENT_TIMESTAMP,
        approved_at = CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END
        WHERE id = ? AND status = ?`)
        .bind(nextStatus, note, nextStatus, proposalId, proposal.status),
      d1.prepare(`INSERT INTO proposal_audit_events (proposal_id, actor_user_id, action, detail)
        SELECT ?, ?, ?, ? WHERE changes() > 0`)
        .bind(proposalId, auth.user.id, action, detail),
    ]);
    if (!updateResult.meta.changes) {
      return Response.json({ error: "方案状态已被其他导师更新，请刷新后查看" }, { status: 409 });
    }
    return Response.json({
      status: nextStatus,
      message: action === "approve" ? "研究方案已确认并冻结当前版本" : action === "reopen" ? "方案已重开，管理员可以代录新版本" : "修改意见已退回管理员修订",
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "研究方案更新失败" },
      { status: error instanceof InputError ? 400 : 500 },
    );
  }
}
