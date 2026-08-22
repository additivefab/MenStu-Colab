"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { paperDeadlineState, paperStageMeta, paperStages, type PaperStage } from "../../../lib/paper-progress";

type ProgressStatus = "pending" | "substantive" | "supporting" | "supplement" | "rejected";
type ReviewStatus = "submitted" | "in_review" | "accepted" | "changes_requested" | "rejected";
type ProposalStatus = "draft" | "submitted" | "changes_requested" | "approved";
type MilestoneStatus = "pending" | "in_progress" | "completed" | "blocked";
type ViewerRole = "superadmin" | "admin" | "student";

type StudentProgress = {
  id: number;
  kind: string;
  title: string;
  summary: string;
  evidence: string;
  literature_ref: string;
  git_url: string;
  status: ProgressStatus;
  review_status: ReviewStatus;
  assessment: "substantive" | "supporting" | null;
  reviewer_note: string;
  reviewer_name: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  can_finalize?: boolean;
  paper: {
    id: number;
    title: string;
    stage: PaperStage;
    manuscript_version: string;
    next_action: string;
    next_action_due_date: string;
    blocker: string;
    submission_identifier: string;
  } | null;
  attachments: Array<{
    id: number;
    file_name: string;
    size_bytes: number;
    content_sha256: string;
    download_url: string;
  }>;
  evidence_sources: Array<{
    id: number;
    source_type: string;
    label: string;
    source_ref: string;
    content_sha256: string;
  }>;
  audit: Array<{
    id: number;
    action: string;
    from_status: string;
    to_status: string;
    assessment: string;
    note: string;
    created_at: string;
    actor_name: string | null;
    actor_type: string;
  }>;
};

type StudentPaper = {
  id: number;
  student_id: string;
  title: string;
  paper_type: string;
  target_venue: string;
  planned_submission_date: string | null;
  current_stage: PaperStage;
  submission_identifier: string;
  status: "active" | "on_hold" | "accepted" | "published" | "closed";
  latest_progress_at: string | null;
  updated_at: string;
  update_count: number;
  pending_count: number;
};

type Student = {
  id: string;
  name: string;
  degree: "博士" | "硕士";
  gradeYear: number;
  stage: string;
  cadenceDays: number;
  currentFocus: string;
  lastSubstantiveAt: string | null;
  latestTitle: string;
  latestKind: string;
  outputCount: number;
  risk: { level: "正常" | "黄色" | "橙色" | "红色"; days: number };
  progress: StudentProgress[];
};

type Milestone = {
  id: number;
  title: string;
  target_date: string;
  evidence_target: string;
  status: MilestoneStatus;
  sort_order: number;
};

type Proposal = {
  id: number;
  student_id: string;
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
  updated_at: string;
  milestones: Milestone[];
  versions: Array<{ id: number; version_number: number; created_at: string; submitted_by_name: string }>;
  audit: Array<{ id: number; action: string; detail: string; created_at: string; actor_name: string }>;
};

type ResearchOutput = {
  id: number;
  student_id: string;
  output_type: "paper" | "dataset" | "software" | "patent" | "report" | "presentation" | "other";
  title: string;
  lifecycle_status: "planned" | "in_progress" | "submitted" | "accepted" | "published" | "archived";
  venue: string;
  identifier: string;
  url: string;
  summary: string;
  linked_milestone_id: number | null;
  milestone_title: string | null;
  created_by_name: string;
  updated_at: string;
  events: Array<{ id: number; action: string; detail: string; created_at: string; actor_name: string }>;
};

type GuidanceNote = {
  id: number;
  student_id: string;
  source_progress_entry_id: number | null;
  guidance_type: "meeting_followup" | "paper" | "milestone" | "blocker" | "general";
  title: string;
  content: string;
  next_action: string;
  due_date: string | null;
  status: "open" | "completed";
  created_at: string;
  updated_at: string;
  mentor_name: string;
  source_title: string | null;
  source_kind: string | null;
};

type MeetingSummary = {
  link_id: number;
  import_id: number;
  progress_entry_id: number;
  title: string;
  summary: string;
  evidence: string;
  review_status: ReviewStatus;
  assessment: "substantive" | "supporting" | null;
  reviewer_note: string;
  submitted_at: string;
  detected_reason: string;
  message_created_at: string;
  received_at: string;
  saved_at: string;
  source_type: string | null;
  source_label: string | null;
  content_sha256: string | null;
};

const reviewLabels: Record<ReviewStatus, string> = {
  submitted: "等待导师接手",
  in_review: "导师审核中",
  accepted: "审核通过",
  changes_requested: "需要补充证据",
  rejected: "未认定为进展",
};

const outputTypeLabels: Record<ResearchOutput["output_type"], string> = {
  paper: "论文",
  dataset: "数据集",
  software: "软件",
  patent: "专利",
  report: "报告",
  presentation: "报告展示",
  other: "其他成果",
};

const outputLifecycleLabels: Record<ResearchOutput["lifecycle_status"], string> = {
  planned: "计划中",
  in_progress: "形成中",
  submitted: "已投稿/提交",
  accepted: "已接收",
  published: "已发表/发布",
  archived: "已归档",
};

const proposalLabels: Record<ProposalStatus, string> = {
  draft: "方案草稿",
  submitted: "等待导师审核",
  changes_requested: "需要修改",
  approved: "已确认执行",
};

const paperStatusLabels: Record<StudentPaper["status"], string> = {
  active: "推进中",
  on_hold: "暂缓",
  accepted: "已录用",
  published: "已发表",
  closed: "已关闭",
};

const milestoneLabels: Record<MilestoneStatus, string> = {
  pending: "未开始",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "受阻",
};

const auditLabels: Record<string, string> = {
  save_draft: "保存方案草稿",
  submit: "提交方案审核",
  approve: "导师确认方案",
  request_changes: "退回方案修改",
  reopen: "重开方案修订",
  milestone_update: "更新培养节点",
};

const PAGE_REFERENCE_TIME = Date.now();

function dateText(value: string | null) {
  if (!value) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(new Date(value));
}

function targetText(value: string, status: MilestoneStatus) {
  if (status === "completed") return "已完成";
  if (!value) return "日期待确定";
  const target = new Date(`${value}T00:00:00`);
  const today = new Date(PAGE_REFERENCE_TIME);
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天后`;
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><p>{value || "尚未填写"}</p></div>;
}

export default function StudentOverview({ studentId }: { studentId: string }) {
  const [student, setStudent] = useState<Student | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [outputs, setOutputs] = useState<ResearchOutput[]>([]);
  const [papers, setPapers] = useState<StudentPaper[]>([]);
  const [guidanceNotes, setGuidanceNotes] = useState<GuidanceNote[]>([]);
  const [meetingSummaries, setMeetingSummaries] = useState<MeetingSummary[]>([]);
  const [viewerRole, setViewerRole] = useState<ViewerRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [outputOpen, setOutputOpen] = useState(false);
  const [outputBusy, setOutputBusy] = useState(false);
  const [outputUpdateBusy, setOutputUpdateBusy] = useState<number | null>(null);
  const [outputMessage, setOutputMessage] = useState("");
  const [progressBusy, setProgressBusy] = useState<number | null>(null);
  const [progressMessage, setProgressMessage] = useState<Record<number, string>>({});
  const [milestoneBusy, setMilestoneBusy] = useState<number | null>(null);
  const [milestoneMessage, setMilestoneMessage] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [reviewBusy, setReviewBusy] = useState<number | null>(null);
  const [guidanceMessage, setGuidanceMessage] = useState("");
  const [guidanceSaveBusy, setGuidanceSaveBusy] = useState(false);
  const [guidanceStatusBusy, setGuidanceStatusBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const dashboardResponse = await fetch("/api/dashboard", { cache: "no-store" });
      const dashboard = (await dashboardResponse.json()) as {
        viewer?: { role: ViewerRole };
        students?: Student[];
        papers?: StudentPaper[];
        pending?: Array<StudentProgress & { can_finalize: boolean }>;
        error?: string;
      };
      if (!dashboardResponse.ok) throw new Error(dashboard.error || "学生信息读取失败");
      if (dashboard.viewer?.role === "student") {
        window.location.replace("/");
        return;
      }
      const [proposalResponse, outputResponse, guidanceResponse] = await Promise.all([
        fetch("/api/proposals", { cache: "no-store" }),
        fetch(`/api/research-outputs?studentId=${encodeURIComponent(studentId)}`, { cache: "no-store" }),
        fetch(`/api/student-guidance?studentId=${encodeURIComponent(studentId)}`, { cache: "no-store" }),
      ]);
      const proposals = (await proposalResponse.json()) as { proposals?: Proposal[]; error?: string };
      const outputPayload = (await outputResponse.json()) as { outputs?: ResearchOutput[]; error?: string };
      const guidancePayload = (await guidanceResponse.json()) as { notes?: GuidanceNote[]; meetingSummaries?: MeetingSummary[]; error?: string };
      if (!proposalResponse.ok) throw new Error(proposals.error || "研究方案读取失败");
      if (!outputResponse.ok) throw new Error(outputPayload.error || "科研成果读取失败");
      if (!guidanceResponse.ok) throw new Error(guidancePayload.error || "导师指导与飞书总结读取失败");
      const matched = dashboard.students?.find((item) => item.id === studentId) ?? null;
      if (!matched) throw new Error("学生不存在，或当前账号无权查看该学生");
      const reviewability = new Map((dashboard.pending ?? []).map((entry) => [entry.id, entry.can_finalize]));
      setStudent({
        ...matched,
        progress: matched.progress.map((entry) => ({ ...entry, can_finalize: reviewability.get(entry.id) ?? false })),
      });
      setViewerRole(dashboard.viewer?.role ?? null);
      setProposal(proposals.proposals?.find((item) => item.student_id === studentId) ?? null);
      setOutputs(outputPayload.outputs ?? []);
      setPapers((dashboard.papers ?? []).filter((paper) => paper.student_id === studentId));
      setGuidanceNotes(guidancePayload.notes ?? []);
      setMeetingSummaries(guidancePayload.meetingSummaries ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "学生信息读取失败");
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function createOutput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOutputBusy(true); setOutputMessage("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      const response = await fetch("/api/research-outputs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, studentId }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "科研成果登记失败");
      setOutputMessage(payload.message || "科研成果已登记");
      form.reset();
      setOutputOpen(false);
      await load();
    } catch (saveError) {
      setOutputMessage(saveError instanceof Error ? saveError.message : "科研成果登记失败");
    } finally { setOutputBusy(false); }
  }

  async function updateOutputLifecycle(output: ResearchOutput, lifecycleStatus: ResearchOutput["lifecycle_status"]) {
    setOutputUpdateBusy(output.id); setOutputMessage("");
    try {
      const response = await fetch("/api/research-outputs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: output.id,
          outputType: output.output_type,
          lifecycleStatus,
          title: output.title,
          venue: output.venue,
          identifier: output.identifier,
          url: output.url,
          summary: output.summary,
          linkedMilestoneId: output.linked_milestone_id,
        }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "成果阶段更新失败");
      setOutputMessage(payload.message || "成果阶段已更新");
      await load();
    } catch (saveError) {
      setOutputMessage(saveError instanceof Error ? saveError.message : "成果阶段更新失败");
    } finally { setOutputUpdateBusy(null); }
  }

  async function resubmitProgress(event: FormEvent<HTMLFormElement>, entry: StudentProgress) {
    event.preventDefault();
    setProgressBusy(entry.id);
    setProgressMessage((current) => ({ ...current, [entry.id]: "" }));
    const formData = new FormData(event.currentTarget);
    formData.set("id", String(entry.id));
    formData.set("kind", entry.kind);
    formData.set("title", entry.title);
    try {
      const response = await fetch("/api/progress", {
        method: "PATCH",
        body: formData,
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "补充证据提交失败");
      setProgressMessage((current) => ({ ...current, [entry.id]: payload.message || "补充证据已重新提交" }));
      await load();
    } catch (saveError) {
      setProgressMessage((current) => ({ ...current, [entry.id]: saveError instanceof Error ? saveError.message : "补充证据提交失败" }));
    } finally { setProgressBusy(null); }
  }

  async function updateMilestone(milestoneId: number, status: MilestoneStatus) {
    setMilestoneBusy(milestoneId); setMilestoneMessage("");
    try {
      const response = await fetch("/api/proposals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_milestone", milestoneId, status }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "培养节点更新失败");
      setMilestoneMessage(payload.message || "培养节点已更新");
      await load();
    } catch (saveError) {
      setMilestoneMessage(saveError instanceof Error ? saveError.message : "培养节点更新失败");
    } finally { setMilestoneBusy(null); }
  }

  async function createGuidance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setGuidanceSaveBusy(true);
    setGuidanceMessage("");
    try {
      const response = await fetch("/api/student-guidance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, studentId }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "导师指导保存失败");
      setGuidanceMessage(payload.message || "导师指导已保存到学生档案");
      form.reset();
      await load();
    } catch (saveError) {
      setGuidanceMessage(saveError instanceof Error ? saveError.message : "导师指导保存失败");
    } finally {
      setGuidanceSaveBusy(false);
    }
  }

  async function updateGuidanceStatus(note: GuidanceNote, status: GuidanceNote["status"]) {
    setGuidanceStatusBusy(note.id);
    setGuidanceMessage("");
    try {
      const response = await fetch("/api/student-guidance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: note.id, status }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "导师指导状态更新失败");
      setGuidanceMessage(payload.message || "导师指导状态已更新");
      await load();
    } catch (saveError) {
      setGuidanceMessage(saveError instanceof Error ? saveError.message : "导师指导状态更新失败");
    } finally {
      setGuidanceStatusBusy(null);
    }
  }

  async function reviewProgress(entry: StudentProgress, action: "start_review" | "substantive" | "supporting" | "supplement" | "rejected") {
    const note = (reviewNotes[entry.id] || "").trim();
    if ((action === "supplement" || action === "rejected") && !note) {
      setGuidanceMessage("需要补充或判定为非进展时，请先写清具体指导意见。");
      return;
    }
    if (!entry.can_finalize) {
      setGuidanceMessage(entry.reviewer_name ? `该证据正在由 ${entry.reviewer_name} 审核` : "当前账号不能审核这条进展");
      return;
    }
    setReviewBusy(entry.id);
    setGuidanceMessage("");
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, action, note }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "指导意见保存失败");
      setGuidanceMessage(action === "start_review" ? "已接手审核，可继续形成导师判断。" : payload.message || "导师判断与指导意见已保存。");
      await load();
    } catch (reviewError) {
      setGuidanceMessage(reviewError instanceof Error ? reviewError.message : "指导意见保存失败");
    } finally {
      setReviewBusy(null);
    }
  }

  const summary = useMemo(() => {
    const progress = student?.progress ?? [];
    const reviewed = progress.filter((entry) => ["accepted", "changes_requested", "rejected"].includes(entry.review_status)).length;
    const substantive = progress.filter((entry) => entry.assessment === "substantive" || entry.status === "substantive").length;
    const supporting = progress.filter((entry) => entry.assessment === "supporting" || entry.status === "supporting").length;
    const returned = progress.filter((entry) => entry.review_status === "changes_requested").length;
    const rejected = progress.filter((entry) => entry.review_status === "rejected").length;
    const pending = progress.filter((entry) => entry.review_status === "submitted" || entry.review_status === "in_review").length;
    const evidenceReady = progress.filter((entry) => Boolean(entry.evidence.trim()) && (entry.evidence_sources.length > 0 || entry.attachments.length > 0)).length;
    const attachmentCount = progress.reduce((count, entry) => count + entry.attachments.length, 0);
    const sourceCount = progress.reduce((count, entry) => count + entry.evidence_sources.filter((source) => source.source_type !== "attachment").length, 0);
    const completedMilestones = proposal?.milestones.filter((item) => item.status === "completed").length ?? 0;
    return {
      reviewed,
      substantive,
      supporting,
      returned,
      rejected,
      pending,
      evidenceReady,
      evidencePercent: progress.length ? Math.round((evidenceReady / progress.length) * 100) : 0,
      attachmentCount,
      sourceCount,
      completedMilestones,
      totalMilestones: proposal?.milestones.length ?? 0,
    };
  }, [proposal, student]);

  const insights = useMemo(() => {
    const progress = student?.progress ?? [];
    const milestones = [...(proposal?.milestones ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    const nextMilestone = milestones.find((item) => item.status === "blocked")
      ?? milestones.find((item) => item.status === "in_progress")
      ?? milestones.find((item) => item.status === "pending")
      ?? null;
    const weeks = Array.from({ length: 8 }, (_, index) => {
      const start = new Date(PAGE_REFERENCE_TIME);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (7 - index) * 7);
      return { start, label: `${start.getMonth() + 1}/${start.getDate()}`, count: 0, substantive: 0 };
    });
    progress.forEach((entry) => {
      const submitted = new Date(entry.submitted_at);
      const age = Math.floor((PAGE_REFERENCE_TIME - submitted.getTime()) / 86_400_000);
      const bucket = 7 - Math.floor(age / 7);
      if (bucket >= 0 && bucket < weeks.length) {
        weeks[bucket].count += 1;
        if (entry.assessment === "substantive" || entry.status === "substantive") weeks[bucket].substantive += 1;
      }
    });
    const maxActivity = Math.max(1, ...weeks.map((week) => week.count));
    const missingInformation = [
      !student?.currentFocus ? "研究重点" : "",
      !proposal ? "研究方案" : "",
      !milestones.length ? "培养节点" : "",
      !progress.length ? "进展记录" : "",
      !progress.some((entry) => entry.evidence_sources.length > 0 || Boolean(entry.evidence)) ? "可溯源证据" : "",
      !outputs.length ? "科研成果" : "",
    ].filter(Boolean);
    const planPercent = milestones.length ? Math.round((milestones.filter((item) => item.status === "completed").length / milestones.length) * 100) : 0;

    let action = { label: "保持节奏", title: "按个人周期提交下一条可核验进展", detail: "继续围绕当前研究重点记录新增结论和证据。", tone: "green" };
    if (!proposal) action = { label: "优先行动", title: "建立个人研究方案", detail: "先明确科学问题、研究假设、技术路线与培养节点。", tone: "blue" };
    else if (proposal.status === "changes_requested") action = { label: "优先行动", title: "按导师意见修订研究方案", detail: proposal.reviewer_note || "形成新版本后再次提交导师确认。", tone: "amber" };
    else if (proposal.status === "draft") action = { label: "优先行动", title: "完成研究方案并提交审核", detail: "提交后系统会保留不可覆盖的版本快照。", tone: "blue" };
    else if (proposal.status === "submitted") action = { label: "导师行动", title: "研究方案正在等待导师审核", detail: "审核完成前当前版本保持锁定。", tone: "amber" };
    else if (nextMilestone?.status === "blocked") action = { label: "优先行动", title: `解除阻塞：${nextMilestone.title}`, detail: nextMilestone.evidence_target || "明确阻塞原因、所需决策和替代方案。", tone: "amber" };
    else if (progress.some((entry) => entry.review_status === "changes_requested")) action = { label: "优先行动", title: "补充导师退回的进展证据", detail: "保留原记录和审核意见，补证后重新提交，形成完整审核链。", tone: "amber" };
    else if (student?.risk.level !== "正常") action = { label: "优先行动", title: "补充一条可核验的实质性进展", detail: `已连续 ${student?.risk.days ?? 0} 天没有确认的实质性进展。`, tone: "amber" };
    else if (progress.some((entry) => entry.review_status === "submitted" || entry.review_status === "in_review")) action = { label: "导师行动", title: "审核最新个人进展", detail: `当前有 ${progress.filter((entry) => entry.review_status === "submitted" || entry.review_status === "in_review").length} 条证据等待导师判断。`, tone: "blue" };
    else if (nextMilestone) action = { label: "下一节点", title: nextMilestone.title, detail: nextMilestone.evidence_target || "围绕节点目标提交可核验成果。", tone: "green" };

    let updateWindow = "首次实质性进展待确认";
    if (student?.lastSubstantiveAt) {
      const due = new Date(student.lastSubstantiveAt);
      due.setDate(due.getDate() + student.cadenceDays);
      updateWindow = dateText(due.toISOString());
    }
    return { action, missingInformation, maxActivity, milestones, nextMilestone, planPercent, updateWindow, weeks };
  }, [outputs, proposal, student]);

  if (loading) return <main className="student-page"><div className="student-page-state"><i /><strong>正在整理学生科研全景…</strong></div></main>;
  if (error || !student) return <main className="student-page"><div className="student-page-state error"><strong>暂时无法打开学生页面</strong><p>{error}</p><Link href="/">返回科研进展驾驶舱</Link></div></main>;

  const flow = [
    { label: "学生身份", value: `${student.gradeYear}级${student.degree}`, note: student.stage, tone: "blue" },
    { label: "研究方案", value: proposal ? proposalLabels[proposal.status] : "尚未建立", note: proposal?.title || "等待学生撰写", tone: proposal?.status === "approved" ? "green" : "blue" },
    { label: "培养节点", value: `${summary.completedMilestones}/${summary.totalMilestones} 已完成`, note: proposal?.milestones.find((item) => item.status === "in_progress")?.title || "暂无进行中节点", tone: summary.completedMilestones ? "green" : "blue" },
    { label: "研究证据", value: `${student.progress.length} 条进展`, note: `${summary.pending} 条等待审核`, tone: summary.pending ? "amber" : "green" },
    { label: "科研成果", value: `${outputs.length} 项`, note: outputs[0]?.title || "等待登记成果资产", tone: outputs.length ? "green" : "blue" },
    { label: "归档与状态", value: student.risk.level, note: `${student.risk.days} 天距最近实质性进展`, tone: student.risk.level === "正常" ? "green" : "amber" },
  ];
  const pendingGuidance = student.progress.filter((entry) => entry.review_status === "submitted" || entry.review_status === "in_review");

  return <main className="student-page">
    <nav className="student-page-nav"><Link href="/">← 返回驾驶舱</Link><span>探研 · 学生科研全景</span></nav>

    <header className="student-hero">
      <div className="student-hero-profile"><div className="student-hero-avatar">{student.name.slice(-2)}</div><div><p>导师决策视图 · {student.gradeYear}级{student.degree}</p><h1>{student.name}</h1><div className="student-hero-tags"><span className={`risk ${student.risk.level}`}>{student.risk.level}</span><span>{student.stage}</span><span>{papers.length} 篇论文</span></div></div></div>
      <div className="student-hero-focus"><span>当前研究重点</span><strong>{student.currentFocus || "尚未填写"}</strong><small>{student.cadenceDays} 天更新周期 · 最近实质性进展 {dateText(student.lastSubstantiveAt)}</small></div>
      <div className="student-hero-evidence" aria-label={`证据完备度 ${summary.evidencePercent}%`}>
        <div style={{ background: `conic-gradient(#75d7ad ${summary.evidencePercent * 3.6}deg, rgba(255,255,255,.13) 0)` }}><span><strong>{summary.evidencePercent}%</strong><small>证据完备</small></span></div>
        <p>{summary.sourceCount} 个来源 · {summary.attachmentCount} 个附件</p>
      </div>
    </header>

    <nav className="student-section-nav" aria-label="学生档案章节">
      <a href="#guidance">导师指导</a><a href="#ai-summaries">AI 总结</a><a href="#papers">论文图谱</a><a href="#workflow">培养流程</a><a href="#evidence">进展证据</a><a href="#outputs">科研成果</a><a href="#proposal">研究方案</a><a href="#audit">审计记录</a>
    </nav>

    <section className={`student-next-action ${insights.action.tone}`}>
      <div className="student-next-lead"><span>{insights.action.label}</span><h2>{insights.action.title}</h2><p>{insights.action.detail}</p></div>
      <div><span>下一培养节点</span><strong>{insights.nextMilestone?.title || "培养节点已完成或待建立"}</strong><small>{insights.nextMilestone ? targetText(insights.nextMilestone.target_date, insights.nextMilestone.status) : "—"}</small></div>
      <div><span>下次更新窗口</span><strong>{insights.updateWindow}</strong><small>{student.cadenceDays} 天个人更新周期</small></div>
      <div><span>档案缺口</span><strong>{insights.missingInformation.length ? insights.missingInformation.join("、") : "核心档案完整"}</strong><small>{insights.missingInformation.length ? "补齐后可形成完整培养闭环" : "重点、方案、节点、证据与成果均可追溯"}</small></div>
    </section>

    <section className="student-guidance-workbench" id="guidance">
      <div className="student-guidance-intro">
        <div><span>MENTOR GUIDANCE DESK</span><h2>导师自由指导区</h2><p>这里是一张开放的指导便笺：导师自由书写主题和内容，不需要先选择结论，也不依赖待审核进展。</p></div>
        <strong>{guidanceNotes.filter((note) => note.status === "open").length}<small>项进行中</small></strong>
      </div>
      <form className="student-guidance-compose" onSubmit={createGuidance}>
        <div className="student-guidance-compose-title"><span>自由书写</span><strong>给 {student.name} 留下一条真正有内容的指导</strong><small>只有指导内容必填；主题、关联资料、下一步和期限都可以按实际需要使用。</small></div>
        <input name="guidanceType" type="hidden" value="general" />
        <label>指导主题（可选）<input name="title" maxLength={200} placeholder="自由填写，例如：下一轮实验设计建议" /></label>
        <label>关联飞书 AI 总结<select name="sourceProgressEntryId" defaultValue=""><option value="">不关联具体总结</option>{meetingSummaries.map((item) => <option key={item.progress_entry_id} value={item.progress_entry_id}>{dateText(item.message_created_at)} · {item.title}</option>)}</select></label>
        <label className="wide">导师想说的话<textarea name="content" rows={6} required maxLength={3000} placeholder="自由记录研究判断、方法建议、问题讨论、阅读建议、实验思路或任何需要学生关注的内容。" /></label>
        <label>下一项可交付行动<input name="nextAction" maxLength={800} placeholder="例如：补做消融实验并更新结果表" /></label>
        <label>建议完成期限<input name="dueDate" type="date" /></label>
        <div className="student-guidance-compose-actions"><span>指导记录与飞书总结分别保存，关联后可以相互追溯。</span><button className="primary" disabled={guidanceSaveBusy}>{guidanceSaveBusy ? "保存中…" : "保存导师指导"}</button></div>
      </form>
      {guidanceMessage ? <p className="student-guidance-message" role="status">{guidanceMessage}</p> : null}
      <div className="student-guidance-ledger">
        <div className="student-guidance-ledger-head"><div><span>GUIDANCE LOG</span><h3>已保存的导师指导</h3></div><strong>{guidanceNotes.length}</strong></div>
        <div>{guidanceNotes.map((note) => <details key={note.id} className={note.status}>
          <summary><span className={`student-guidance-state ${note.status}`}>{note.status === "open" ? "进行中" : "已完成"}</span><div><strong>{note.title || "自由指导"}{note.source_title ? ` · ${note.source_title}` : ""}</strong><small>{note.mentor_name} · {dateText(note.created_at)}</small></div><i>展开查看</i></summary>
          <div className="student-guidance-note-body"><p>{note.content}</p>{note.next_action ? <dl><div><dt>下一项行动</dt><dd>{note.next_action}</dd></div>{note.due_date ? <div><dt>建议期限</dt><dd>{note.due_date}</dd></div> : null}</dl> : null}<footer><span>{note.source_title ? `关联 ${note.source_kind || "进展"}：${note.source_title}` : "独立指导记录"}</span><button type="button" disabled={guidanceStatusBusy === note.id} onClick={() => void updateGuidanceStatus(note, note.status === "open" ? "completed" : "open")}>{note.status === "open" ? "标记已完成" : "重新打开"}</button></footer></div>
        </details>)}{!guidanceNotes.length ? <div className="student-guidance-ledger-empty">尚无已保存指导；使用上方表单即可建立第一条。</div> : null}</div>
      </div>
      <details className="student-formal-review">
        <summary><div><span>FORMAL REVIEW</span><strong>正式进展审核</strong><small>“实质性进展”等是系统状态判断，不是导师自由指导。</small></div><em>{pendingGuidance.length} 项待审</em><i aria-hidden="true" /></summary>
        <div className="student-formal-review-body">
      <div className="student-guidance-steps" aria-label="正式审核流程"><span><i>1</i><b>看新增结论</b><small>先判断学生本次真正推进了什么</small></span><span><i>2</i><b>核对证据</b><small>检查来源、附件与论文版本</small></span><span><i>3</i><b>记录状态</b><small>形成正式进展判断</small></span></div>
      <div className="student-guidance-list">
        {pendingGuidance.map((entry) => <article key={entry.id}>
          <header><div className={`student-guidance-kind ${entry.paper ? "paper" : "general"}`}>{entry.paper ? "论" : entry.kind.slice(0, 1)}</div><div><span>{entry.paper ? `${paperStageMeta[entry.paper.stage].label} · ${entry.paper.manuscript_version}` : entry.kind}</span><h3>{entry.paper?.title || entry.title}</h3><small>{dateText(entry.submitted_at)} · {entry.evidence_sources.length} 个来源 · {entry.attachments.length} 个附件</small></div><em className={entry.review_status}>{reviewLabels[entry.review_status]}</em></header>
          <div className="student-guidance-evidence"><div><span>新增结论</span><p>{entry.summary}</p></div><div><span>核验证据</span><p>{entry.evidence || "尚未填写"}</p></div>{entry.paper ? <div><span>下一行动</span><p>{entry.paper.next_action} · {entry.paper.next_action_due_date}</p></div> : null}</div>
          <div className="student-guidance-assets" aria-label="待审核证据材料">
            {entry.evidence_sources.filter((source) => source.source_type !== "attachment").map((source) => <span key={source.id}><b>{source.label}</b>{source.source_ref ? source.source_type === "git" || source.source_type === "url" ? <a href={source.source_ref} target="_blank" rel="noreferrer">打开来源 ↗</a> : <small>{source.source_ref}</small> : null}</span>)}
            {entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><b>附件 · {attachment.file_name}</b><small>{Math.max(1, Math.round(attachment.size_bytes / 1024))} KB · 指纹 {attachment.content_sha256}</small></a>)}
            {!entry.evidence_sources.some((source) => source.source_type !== "attachment") && !entry.attachments.length ? <span><b>仅有文本证据</b><small>如不足以判断，可要求学生补充来源或文件。</small></span> : null}
          </div>
          <label>导师指导意见<textarea rows={3} maxLength={3000} value={reviewNotes[entry.id] || ""} disabled={!entry.can_finalize} onChange={(event) => setReviewNotes((current) => ({ ...current, [entry.id]: event.target.value }))} placeholder="写清判断依据、需要修正的问题和下一项可交付成果；退回补证或判定非进展时必填。" /></label>
          <footer>{entry.can_finalize ? <>{entry.review_status === "submitted" ? <button disabled={reviewBusy === entry.id} onClick={() => void reviewProgress(entry, "start_review")}>接手审核</button> : null}<button className="approve" disabled={reviewBusy === entry.id} onClick={() => void reviewProgress(entry, "substantive")}>确认实质性进展</button><button disabled={reviewBusy === entry.id} onClick={() => void reviewProgress(entry, "supporting")}>记为支持性工作</button><button disabled={reviewBusy === entry.id || !(reviewNotes[entry.id] || "").trim()} onClick={() => void reviewProgress(entry, "supplement")}>要求补充证据</button><button className="reject" disabled={reviewBusy === entry.id || !(reviewNotes[entry.id] || "").trim()} onClick={() => void reviewProgress(entry, "rejected")}>不认定为进展</button></> : <p>{entry.reviewer_name ? `该记录正在由 ${entry.reviewer_name} 审核` : "该记录不可由当前账号审核"}</p>}</footer>
        </article>)}
        {!pendingGuidance.length ? <div className="student-guidance-clear"><i>✓</i><div><strong>当前没有待审核进展</strong><p>导师仍可继续使用上方自由指导区。</p></div><a href="#evidence">查看完整证据链 ↓</a></div> : null}
      </div>
        </div>
      </details>
    </section>

    <section className="student-ai-summary-archive" id="ai-summaries">
      <div className="student-section-head"><div><span>FEISHU AI SUMMARY ARCHIVE</span><h2>飞书 AI 总结汇总</h2><p>所有已归属到 {student.name} 的智能纪要集中保存在这里；列表先看摘要，点开后查看完整内容与导师反馈。</p></div><em>{meetingSummaries.length}</em></div>
      <div className="student-ai-summary-stats"><div><span>已保存总结</span><strong>{meetingSummaries.length}</strong><small>按学生归档，不与其他学生混合</small></div><div><span>等待导师判断</span><strong>{meetingSummaries.filter((item) => item.review_status === "submitted" || item.review_status === "in_review").length}</strong><small>可在上方指导工作台处理</small></div><div><span>最近一次导入</span><strong>{dateText(meetingSummaries[0]?.message_created_at ?? null)}</strong><small>{meetingSummaries[0]?.source_label || "尚无飞书总结"}</small></div></div>
      <div className="student-ai-summary-list">
        {meetingSummaries.map((item) => <details key={item.link_id}>
          <summary><span className="student-ai-mark">AI</span><div><small>{dateText(item.message_created_at)} · {item.source_label || "飞书智能纪要"}</small><strong>{item.title}</strong><p>{item.summary}</p></div><span className="student-ai-saved">✓ 已保存</span><i>点开查看</i></summary>
          <div className="student-ai-summary-body"><div className="student-ai-summary-content"><span>完整总结</span><p>{item.summary}</p></div><dl><div><dt>导入识别</dt><dd>{item.detected_reason || "飞书 AI 总结"}</dd></div><div><dt>证据说明</dt><dd>{item.evidence || "飞书智能纪要自动归档"}</dd></div><div><dt>审核状态</dt><dd>{reviewLabels[item.review_status]}{item.assessment ? ` · ${item.assessment === "substantive" ? "实质性进展" : "支持性工作"}` : ""}</dd></div><div><dt>保存时间</dt><dd>{dateText(item.saved_at)}</dd></div>{item.content_sha256 ? <div><dt>内容指纹</dt><dd>{item.content_sha256.slice(0, 12)}</dd></div> : null}</dl>{item.reviewer_note ? <blockquote><b>导师反馈</b><p>{item.reviewer_note}</p></blockquote> : null}<footer><span>已作为个人进展 #{item.progress_entry_id} 保存</span><a href={`#progress-${item.progress_entry_id}`}>查看对应证据链 ↓</a></footer></div>
        </details>)}
        {!meetingSummaries.length ? <div className="student-ai-summary-empty"><i>AI</i><div><strong>尚无已归属的飞书 AI 总结</strong><p>在飞书导入并识别到该学生后，总结会自动保存并出现在这里。</p></div></div> : null}
      </div>
    </section>

    <section className="student-paper-landscape" id="papers">
      <div className="student-section-head"><div><span>PAPER LANDSCAPE</span><h2>论文推进图谱</h2><p>把每篇论文放在统一的九阶段门上，导师可以一眼看到当前位置、质量门、下一行动和投稿压力。</p></div><em>{papers.length}</em></div>
      <div className="student-paper-landscape-list">
        {papers.map((paper) => {
          const currentIndex = paperStages.indexOf(paper.current_stage);
          const deadline = paperDeadlineState(paper.planned_submission_date, new Date(PAGE_REFERENCE_TIME));
          const latestUpdate = student.progress.find((entry) => entry.paper?.id === paper.id);
          return <article key={paper.id}>
            <header><div><span className={`paper-stage stage-${paper.current_stage}`}>{paperStageMeta[paper.current_stage].label}</span><span className={`student-paper-status ${paper.status}`}>{paperStatusLabels[paper.status]}</span></div><div className={`student-paper-deadline ${deadline.overdue ? "overdue" : ""}`}><small>计划投稿</small><strong>{deadline.label}</strong></div></header>
            <div className="student-paper-title"><div><p>{paper.paper_type}{paper.target_venue ? ` · ${paper.target_venue}` : " · 投稿目标待确定"}</p><h3>{paper.title}</h3></div><dl><div><dt>版本进展</dt><dd>{paper.update_count} 次</dd></div><div><dt>待审</dt><dd>{paper.pending_count}</dd></div><div><dt>最新更新</dt><dd>{dateText(paper.latest_progress_at)}</dd></div></dl></div>
            <ol className="paper-stage-roadmap" aria-label={`${paper.title}论文阶段`}>
              {paperStages.map((stage, index) => <li key={stage} className={index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming"}><i>{index < currentIndex ? "✓" : index + 1}</i><span>{paperStageMeta[stage].label}</span></li>)}
            </ol>
            <div className="student-paper-decision"><div><span>当前质量门</span><strong>{paperStageMeta[paper.current_stage].gate}</strong></div><div><span>下一项可交付行动</span><strong>{latestUpdate?.paper?.next_action || "等待学生提交下一项具体行动"}</strong><small>{latestUpdate?.paper?.next_action_due_date || "期限待设置"}</small></div><div className={latestUpdate?.paper?.blocker ? "blocked" : ""}><span>阻塞与导师介入</span><strong>{latestUpdate?.paper?.blocker || "当前未报告阻塞"}</strong><small>{latestUpdate?.reviewer_note || "可在导师指导工作台中形成意见"}</small></div></div>
          </article>;
        })}
        {!papers.length ? <div className="student-paper-empty"><span>论文台账尚未建立</span><strong>学生首次提交论文进度时，会在这里生成九阶段推进图谱。</strong><p>项目进展不会混入论文图谱。</p></div> : null}
      </div>
    </section>

    <section className="student-flow-card" id="workflow">
      <div className="student-section-head"><div><span>FLOW</span><h2>科研培养流程图</h2><p>从研究身份、方案与培养节点，一直追踪到个人进展、导师审核和当前风险。</p></div></div>
      <ol className="student-flow" aria-label={`${student.name}科研培养流程`}>{flow.map((step, index) => <li key={step.label} className={step.tone}><div><i>{index + 1}</i><span>{step.label}</span><strong>{step.value}</strong><small>{step.note}</small></div>{index < flow.length - 1 ? <b aria-hidden="true">→</b> : null}</li>)}</ol>
    </section>

    <section className="student-page-metrics">
      <article><span>全部个人进展</span><strong>{student.progress.length}</strong><small>只包含 {student.name} 的记录</small></article>
      <article><span>实质性进展</span><strong>{summary.substantive}</strong><small>影响最近进展日期与预警</small></article>
      <article><span>培养节点</span><strong>{summary.completedMilestones}/{summary.totalMilestones}</strong><small>完成数 / 总数</small></article>
      <article><span>科研成果与资产</span><strong>{outputs.length}</strong><small>论文、数据、软件、专利及交付物</small></article>
    </section>

    <section className="student-insight-grid">
      <article className="student-page-panel student-plan-progress">
        <div className="student-section-head"><div><span>LEARNING PLAN</span><h2>培养计划进度</h2><p>按培养节点展示完成度和下一目标，不等同于学生评分。</p></div><em>{insights.planPercent}%</em></div>
        <div className="student-plan-track"><i style={{ width: `${insights.planPercent}%` }} /></div>
        <div className="student-plan-timeline">{insights.milestones.map((milestone, index) => <div key={milestone.id} className={milestone.status}><i>{index + 1}</i><span><strong>{milestone.title}</strong><small>{milestoneLabels[milestone.status]} · {targetText(milestone.target_date, milestone.status)}</small></span></div>)}{!insights.milestones.length ? <div className="student-empty">研究方案中尚未建立培养节点</div> : null}</div>
      </article>
      <article className="student-page-panel student-activity-panel">
        <div className="student-section-head"><div><span>EVIDENCE ACTIVITY</span><h2>最近 8 周证据活动</h2><p>只统计个人进展记录数量，绿色标记其中的实质性进展。</p></div></div>
        <div className="student-evidence-structure" aria-label="进展审核结构"><span><i className="substantive" />实质性 {summary.substantive}</span><span><i className="supporting" />支持性 {summary.supporting}</span><span><i className="pending" />待审核 {summary.pending}</span><span><i className="returned" />待补证 {summary.returned + summary.rejected}</span></div>
        <div className="student-review-distribution" title="证据结构"><i className="substantive" style={{ flexGrow: summary.substantive }} /><i className="supporting" style={{ flexGrow: summary.supporting }} /><i className="pending" style={{ flexGrow: summary.pending }} /><i className="returned" style={{ flexGrow: summary.returned + summary.rejected }} />{!student.progress.length ? <i className="empty" style={{ flexGrow: 1 }} /> : null}</div>
        <div className="student-activity-bars">{insights.weeks.map((week) => <div key={week.start.toISOString()} title={`${week.label}：${week.count} 条进展，其中 ${week.substantive} 条实质性进展`}><strong>{week.count || "·"}</strong><span><i style={{ height: `${Math.max(week.count ? 15 : 5, (week.count / insights.maxActivity) * 100)}%` }} />{week.substantive ? <b style={{ height: `${Math.max(10, (week.substantive / insights.maxActivity) * 100)}%` }} /> : null}</span><small>{week.label}</small></div>)}</div>
      </article>
    </section>

    <section className="student-page-panel student-output-panel" id="outputs">
        <div className="student-section-head"><div><span>RESEARCH OUTPUTS</span><h2>科研成果与资产</h2><p>成果有独立生命周期，不再混入日常进展；每次变更都保留审计记录。</p></div>{viewerRole === "superadmin" || viewerRole === "admin" ? <button className="student-output-add" type="button" onClick={() => setOutputOpen((current) => !current)}>{outputOpen ? "收起" : "＋ 登记成果"}</button> : <em>{outputs.length}</em>}</div>
      {outputOpen && (viewerRole === "superadmin" || viewerRole === "admin") ? <form className="student-output-form" onSubmit={createOutput}>
        <label>成果类型<select name="outputType" required defaultValue="paper">{Object.entries(outputTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>当前阶段<select name="lifecycleStatus" required defaultValue="planned">{Object.entries(outputLifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="wide">成果名称<input name="title" required maxLength={300} placeholder="论文、数据集、软件、专利或报告名称" /></label>
        <label>期刊 / 会议 / 发布位置<input name="venue" maxLength={300} placeholder="可选" /></label>
        <label>DOI / 专利号 / 仓库标识<input name="identifier" maxLength={500} placeholder="可选；同一学生内自动去重" /></label>
        <label>关联培养节点<select name="linkedMilestoneId" defaultValue=""><option value="">暂不关联</option>{proposal?.milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}</select></label>
        <label>成果链接<input name="url" type="url" placeholder="仅支持 https://" /></label>
        <label className="wide">成果说明<textarea name="summary" rows={3} maxLength={4000} placeholder="说明成果贡献、当前状态和下一步；不要填写保密原文" /></label>
        <div className="wide student-output-form-actions"><small>A / C / D 数据边界持续生效；保密代码和专利正文不得上传。</small><button className="primary" disabled={outputBusy}>{outputBusy ? "保存中…" : "保存成果"}</button></div>
      </form> : null}
      {outputMessage ? <p className="student-output-message" role="status">{outputMessage}</p> : null}
      <div className="student-output-grid">{outputs.map((output) => <article key={output.id}>
        <div><span>{outputTypeLabels[output.output_type]}</span>{viewerRole === "superadmin" || viewerRole === "admin" ? <select aria-label={`${output.title}成果阶段`} value={output.lifecycle_status} disabled={outputUpdateBusy === output.id} onChange={(event) => void updateOutputLifecycle(output, event.target.value as ResearchOutput["lifecycle_status"])}>{Object.entries(outputLifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <em className={output.lifecycle_status}>{outputLifecycleLabels[output.lifecycle_status]}</em>}</div>
        <h3>{output.title}</h3>
        <p>{output.summary || "尚未填写成果说明"}</p>
        <dl>{output.venue ? <div><dt>发布位置</dt><dd>{output.venue}</dd></div> : null}{output.identifier ? <div><dt>标识符</dt><dd>{output.identifier}</dd></div> : null}{output.milestone_title ? <div><dt>关联节点</dt><dd>{output.milestone_title}</dd></div> : null}</dl>
        {output.events.length ? <details className="student-output-events"><summary>变更记录（{output.events.length}）</summary>{output.events.map((event) => <div key={event.id}><strong>{event.detail}</strong><small>{event.actor_name} · {dateText(event.created_at)}</small></div>)}</details> : null}
        <footer><span>{output.created_by_name} · {dateText(output.updated_at)}</span>{output.url ? <a href={output.url} target="_blank" rel="noreferrer">打开成果 ↗</a> : null}</footer>
      </article>)}{!outputs.length ? <div className="student-empty">尚未登记科研成果；论文、数据集、软件、专利和阶段报告会显示在这里。</div> : null}</div>
    </section>

    <div className="student-page-grid">
      <section className="student-page-panel student-progress-panel" id="evidence">
        <div className="student-section-head"><div><span>EVIDENCE & REVIEW</span><h2>个人进展与证据链</h2><p>飞书智能纪要和学生主动提交均归入这里；来源、审核和评价分开记录。</p></div><em>{student.progress.length}</em></div>
        <div className="student-progress-timeline">{student.progress.map((entry) => <article key={entry.id} id={`progress-${entry.id}`}>
          <div className="student-timeline-marker"><i /><span>{dateText(entry.submitted_at)}</span></div>
          <div className="student-timeline-card"><div><span className={`status-pill review-${entry.review_status}`}>{reviewLabels[entry.review_status]}</span><small>{entry.paper ? `${paperStageMeta[entry.paper.stage].label} · ${entry.paper.manuscript_version}` : entry.kind} · #{entry.id}</small></div><h3>{entry.paper?.title || entry.title}</h3><p>{entry.summary}</p><dl><div><dt>核验证据</dt><dd>{entry.evidence || "尚未填写"}</dd></div>{entry.paper ? <><div><dt>下一行动</dt><dd>{entry.paper.next_action} · {entry.paper.next_action_due_date}</dd></div>{entry.paper.blocker ? <div><dt>当前阻塞</dt><dd>{entry.paper.blocker}</dd></div> : null}{entry.paper.submission_identifier ? <div><dt>稿件编号 / DOI</dt><dd>{entry.paper.submission_identifier}</dd></div> : null}</> : null}{entry.assessment ? <div><dt>审核判断</dt><dd>{entry.assessment === "substantive" ? "实质性进展" : "支持性工作"}{entry.reviewer_name ? ` · ${entry.reviewer_name}` : ""}</dd></div> : null}{entry.reviewer_note ? <div><dt>审核意见</dt><dd>{entry.reviewer_note}</dd></div> : null}</dl>
            <div className="student-evidence-sources" aria-label="证据来源">{entry.evidence_sources.filter((source) => source.source_type !== "attachment").map((source) => <span key={source.id}><b>{source.label}</b>{source.source_ref ? source.source_type === "git" || source.source_type === "url" ? <a href={source.source_ref} target="_blank" rel="noreferrer">打开 ↗</a> : <small>{source.source_ref}</small> : null}{source.content_sha256 ? <em>指纹 {source.content_sha256}</em> : null}</span>)}{!entry.evidence_sources.some((source) => source.source_type !== "attachment") ? <span><b>历史文本证据</b><small>补证时将建立结构化来源</small></span> : null}</div>
            {entry.attachments?.length ? <div className="student-attachment-list" aria-label="提交附件">{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><b>{attachment.file_name}</b><small>{Math.max(1, Math.round(attachment.size_bytes / 1024))} KB · 指纹 {attachment.content_sha256}</small></a>)}</div> : null}
            {entry.audit.length ? <details className="student-progress-audit"><summary>查看审核轨迹（{entry.audit.length}）</summary>{entry.audit.map((event) => <div key={event.id}><i /><span><strong>{event.actor_name || (event.actor_type === "system" ? "系统" : "未知人员")} · {reviewLabels[event.to_status as ReviewStatus] || event.action}</strong><small>{dateText(event.created_at)}{event.note ? ` · ${event.note}` : ""}</small></span></div>)}</details> : null}
            {entry.review_status === "changes_requested" && (viewerRole === "superadmin" || viewerRole === "admin" || viewerRole === "student") ? <details className="student-resubmit"><summary>补充证据并重新提交</summary><form onSubmit={(event) => void resubmitProgress(event, entry)}><label>更新后的结论<textarea name="summary" rows={3} required defaultValue={entry.summary} /></label><label>补充核验证据<textarea name="evidence" rows={3} required defaultValue={entry.evidence} /></label>{entry.kind === "文献" ? <label>论文题目 / DOI<input name="literatureRef" required defaultValue={entry.literature_ref} /></label> : <input type="hidden" name="literatureRef" value={entry.literature_ref || ""} />}{entry.paper ? <><input type="hidden" name="paperId" value={entry.paper.id} /><input name="gitUrl" type="hidden" value={entry.git_url || ""} /><label>论文阶段<select name="paperStage" defaultValue={entry.paper.stage}>{paperStages.map((stage) => <option key={stage} value={stage}>{paperStageMeta[stage].label}</option>)}</select></label><label>稿件版本<input name="manuscriptVersion" required defaultValue={entry.paper.manuscript_version} /></label><label>下一行动<textarea name="nextAction" rows={2} required defaultValue={entry.paper.next_action} /></label><label>行动期限<input name="nextActionDueDate" type="date" required defaultValue={entry.paper.next_action_due_date} /></label><label>当前阻塞（可选）<textarea name="blocker" rows={2} defaultValue={entry.paper.blocker} /></label><label>稿件编号 / DOI（可选）<input name="submissionIdentifier" defaultValue={entry.paper.submission_identifier} /></label></> : <label>Git 链接（可选）<input name="gitUrl" type="url" defaultValue={entry.git_url} placeholder="仅支持 https://" /></label>}<label>补充附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件，单个不超过 20 MB</small></label>{progressMessage[entry.id] ? <p role="status">{progressMessage[entry.id]}</p> : null}<button className="primary" disabled={progressBusy === entry.id}>{progressBusy === entry.id ? "提交中…" : "保留原记录并重新提交"}</button></form></details> : null}
          </div>
        </article>)}{!student.progress.length ? <div className="student-empty">尚无个人进展记录</div> : null}</div>
      </section>

      <aside className="student-page-side">
        <section className="student-page-panel" id="proposal">
          <div className="student-section-head"><div><span>PROPOSAL</span><h2>研究方案</h2><p>{proposal ? `${proposalLabels[proposal.status]} · 第 ${proposal.current_version} 版` : "尚未建立研究方案"}</p></div></div>
          {proposal ? <><h3 className="student-proposal-title">{proposal.title}</h3><div className="student-proposal-details"><DetailBlock label="科学问题" value={proposal.scientific_question} /><DetailBlock label="研究假设" value={proposal.hypothesis} /><DetailBlock label="研究目标" value={proposal.objectives} /><DetailBlock label="创新点" value={proposal.innovation} /><DetailBlock label="文献基础" value={proposal.literature_basis} /><DetailBlock label="技术路线" value={proposal.methodology} /><DetailBlock label="数据与伦理边界" value={proposal.data_ethics} /><DetailBlock label="风险与备选方案" value={proposal.risks} /><DetailBlock label="资源需求" value={proposal.resources} /><DetailBlock label="参考文献" value={proposal.references_text} />{proposal.reviewer_note ? <DetailBlock label="导师意见" value={proposal.reviewer_note} /> : null}</div></> : <div className="student-empty">等待管理员为该学生建立研究方案</div>}
        </section>

        <section className="student-page-panel" id="milestones">
          <div className="student-section-head"><div><span>MILESTONES</span><h2>培养节点</h2><p>方案确认后的执行路线。</p></div></div>
          <div className="student-milestones">{proposal?.milestones.map((milestone, index) => <article key={milestone.id} className={milestone.status}><i>{index + 1}</i><div><span>{milestoneLabels[milestone.status]}</span><h3>{milestone.title}</h3><p>{milestone.evidence_target || "尚未填写验收证据"}</p><small>目标：{milestone.target_date || "待确定"}</small>{proposal.status === "approved" && viewerRole !== "student" ? <select aria-label={`${milestone.title}状态`} value={milestone.status} disabled={milestoneBusy === milestone.id} onChange={(event) => void updateMilestone(milestone.id, event.target.value as MilestoneStatus)}>{Object.entries(milestoneLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : null}</div></article>)}{!proposal?.milestones.length ? <div className="student-empty">尚无培养节点</div> : null}</div>
          {milestoneMessage ? <p className="student-output-message" role="status">{milestoneMessage}</p> : null}
        </section>

        <section className="student-page-panel" id="audit">
          <div className="student-section-head"><div><span>AUDIT</span><h2>方案审计与版本</h2><p>所有提交、审核与节点变化均保留记录。</p></div></div>
          <div className="student-version-strip">{proposal?.versions.map((version) => <div key={version.id}><strong>V{version.version_number}</strong><span>{version.submitted_by_name} · {dateText(version.created_at)}</span></div>)}{!proposal?.versions.length ? <span>尚无已保存版本</span> : null}</div>
          <div className="student-audit">{proposal?.audit.map((event) => <article key={event.id}><i /><div><strong>{auditLabels[event.action] || event.action}</strong><span>{event.actor_name} · {dateText(event.created_at)}</span><p>{event.detail}</p></div></article>)}{!proposal?.audit.length ? <div className="student-empty">尚无方案审计记录</div> : null}</div>
        </section>
      </aside>
    </div>
  </main>;
}
