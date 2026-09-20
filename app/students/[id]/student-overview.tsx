"use client";

import "./workspace.css";

import Link from "next/link";
import { AiRecordActions, DeletedAiRecords } from "../../../components/ai-record-actions";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paperDeadlineState, paperStageMeta, paperStages, type PaperStage } from "../../../lib/paper-progress";
import { progressFollowUpNotice } from "../../../lib/progress-follow-up";

type ProgressStatus = "pending" | "substantive" | "supporting" | "supplement" | "rejected";
type ReviewStatus = "submitted" | "in_review" | "accepted" | "changes_requested" | "rejected";
type ProposalStatus = "draft" | "submitted" | "changes_requested" | "approved";
type MilestoneStatus = "pending" | "in_progress" | "completed" | "blocked";
type ViewerRole = "superadmin" | "admin" | "student";

type ReviewGuidance = {
  nextAction: string;
  dueDate: string;
  acceptanceCriteria: string;
};

type ReviewGuidanceDraft = ReviewGuidance & { open: boolean };

type StudentProgress = {
  summary_only?: boolean;
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
  current_revision: number;
  ai_summary_origin: boolean;
  can_finalize?: boolean;
  can_decide?: boolean;
  can_release?: boolean;
  claim_stale?: boolean;
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
  project: {
    milestone_id: number | null;
    milestone_title: string;
    milestone_target_date: string | null;
    evidence_target: string;
    proposal_version: number | null;
    next_action: string;
    next_action_due_date: string;
    blocker: string;
    completion_requested: boolean;
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
  can_review: boolean;
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
  acceptance_criteria: string;
  verification_mode: "self_report" | "mentor_verify";
  status: "open" | "completed";
  acknowledged_at: string | null;
  student_reported_at: string | null;
  mentor_verified_at: string | null;
  completed_at: string | null;
  completed_by_name: string | null;
  completion_note: string;
  version: number;
  created_at: string;
  updated_at: string;
  mentor_name: string;
  source_title: string | null;
  source_kind: string | null;
};

type MeetingSummary = {
  current_revision: number;
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

function isPending(entry: StudentProgress) {
  return entry.review_status === "submitted" || entry.review_status === "in_review";
}

function DetailBlock({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><p>{value || "尚未填写"}</p></div>;
}

export default function StudentOverview({ studentId }: { studentId: string }) {
  const [tab, setTab] = useState<"progress" | "guidance" | "research">("progress");
  const [progressFilter, setProgressFilter] = useState<"pending" | "all" | "ai" | "returned">("pending");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focusTarget, setFocusTarget] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [aiRefreshKey, setAiRefreshKey] = useState(0);
  const initialized = useRef(false);
  const [student, setStudent] = useState<Student | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [outputs, setOutputs] = useState<ResearchOutput[]>([]);
  const [papers, setPapers] = useState<StudentPaper[]>([]);
  const [guidanceNotes, setGuidanceNotes] = useState<GuidanceNote[]>([]);
  const [canManageAiRecords, setCanManageAiRecords] = useState(false);
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
  const [reviewGuidanceDrafts, setReviewGuidanceDrafts] = useState<Record<number, ReviewGuidanceDraft>>({});
  const [reviewBusy, setReviewBusy] = useState<number | null>(null);
  const [guidanceMessage, setGuidanceMessage] = useState("");
  const [guidanceSaveBusy, setGuidanceSaveBusy] = useState(false);
  const [guidanceStatusBusy, setGuidanceStatusBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [dashboardResponse, proposalResponse, outputResponse, guidanceResponse] = await Promise.all([
        fetch("/api/dashboard", { cache: "no-store" }),
        fetch("/api/proposals", { cache: "no-store" }),
        fetch(`/api/research-outputs?studentId=${encodeURIComponent(studentId)}`, { cache: "no-store" }),
        fetch(`/api/student-guidance?studentId=${encodeURIComponent(studentId)}`, { cache: "no-store" }),
      ]);
      const dashboard = (await dashboardResponse.json()) as {
        viewer?: { role: ViewerRole };
        students?: Student[];
        papers?: StudentPaper[];
        pending?: Array<StudentProgress & {
          can_finalize: boolean;
          can_decide: boolean;
          can_release: boolean;
          claim_stale: boolean;
        }>;
        error?: string;
      };
      if (!dashboardResponse.ok) throw new Error(dashboard.error || "学生信息读取失败");
      if (dashboard.viewer?.role === "student") {
        window.location.replace("/");
        return;
      }
      const [proposals, outputPayload, guidancePayload] = await Promise.all([
        proposalResponse.json() as Promise<{ proposals?: Proposal[]; error?: string }>,
        outputResponse.json() as Promise<{ outputs?: ResearchOutput[]; error?: string }>,
        guidanceResponse.json() as Promise<{ notes?: GuidanceNote[]; meetingSummaries?: MeetingSummary[]; canManageAiRecords?: boolean; error?: string }>,
      ]);
      if (!proposalResponse.ok) throw new Error(proposals.error || "研究方案读取失败");
      if (!outputResponse.ok) throw new Error(outputPayload.error || "科研成果读取失败");
      if (!guidanceResponse.ok) throw new Error(guidancePayload.error || "导师指导与飞书总结读取失败");
      const matched = dashboard.students?.find((item) => item.id === studentId) ?? null;
      if (!matched) throw new Error("学生不存在，或当前账号无权查看该学生");
      const reviewability = new Map((dashboard.pending ?? []).map((entry) => [entry.id, {
        can_finalize: entry.can_finalize,
        can_decide: entry.can_decide,
        can_release: entry.can_release,
        claim_stale: entry.claim_stale,
      }]));
      if (!initialized.current) {
        initialized.current = true;
        setProgressFilter(matched.progress.some(isPending) ? "pending" : "all");
      }
      setStudent({
        ...matched,
        progress: matched.progress.map((entry) => ({
          ...entry,
          can_finalize: reviewability.get(entry.id)?.can_finalize ?? false,
          can_decide: reviewability.get(entry.id)?.can_decide ?? false,
          can_release: reviewability.get(entry.id)?.can_release ?? false,
          claim_stale: reviewability.get(entry.id)?.claim_stale ?? false,
        })),
      });
      setViewerRole(dashboard.viewer?.role ?? null);
      setProposal(proposals.proposals?.find((item) => item.student_id === studentId) ?? null);
      setOutputs(outputPayload.outputs ?? []);
      setPapers((dashboard.papers ?? []).filter((paper) => paper.student_id === studentId));
      setGuidanceNotes(guidancePayload.notes ?? []);
      setMeetingSummaries(guidancePayload.meetingSummaries ?? []);
      setCanManageAiRecords(guidancePayload.canManageAiRecords === true);
      setAiRefreshKey((current) => current + 1);
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
    formData.set("expectedRevision", String(entry.current_revision));
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
      setComposeOpen(false);
      await load();
    } catch (saveError) {
      setGuidanceMessage(saveError instanceof Error ? saveError.message : "导师指导保存失败");
    } finally {
      setGuidanceSaveBusy(false);
    }
  }

  async function updateGuidanceStatus(note: GuidanceNote, action: "complete" | "reopen") {
    setGuidanceStatusBusy(note.id);
    setGuidanceMessage("");
    try {
      const response = await fetch("/api/student-guidance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: note.id, action, expectedVersion: note.version }),
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

  function guidanceDraft(entry: StudentProgress): ReviewGuidanceDraft {
    return reviewGuidanceDrafts[entry.id] ?? {
      open: false,
      nextAction: entry.paper?.next_action || entry.project?.next_action || "",
      dueDate: entry.paper?.next_action_due_date || entry.project?.next_action_due_date || "",
      acceptanceCriteria: entry.project?.evidence_target || "",
    };
  }

  function updateGuidanceDraft(entry: StudentProgress, patch: Partial<ReviewGuidanceDraft>) {
    setReviewGuidanceDrafts((current) => ({
      ...current,
      [entry.id]: { ...guidanceDraft(entry), ...current[entry.id], ...patch },
    }));
  }

  async function reviewProgress(entry: StudentProgress, action: "start_review" | "release_review" | "substantive" | "supporting" | "supplement" | "rejected", guidance?: ReviewGuidance) {
    const note = (reviewNotes[entry.id] || "").trim();
    if ((action === "supplement" || action === "rejected") && !note) {
      setGuidanceMessage("需要补充或判定为非进展时，请先写清具体指导意见。");
      return;
    }
    if (guidance && (!guidance.nextAction.trim() || !guidance.acceptanceCriteria.trim())) {
      setGuidanceMessage("请填写学生下一步和可判断的完成标准。");
      return;
    }
    const permitted = action === "release_review" ? entry.can_release : action === "start_review" ? entry.can_finalize : entry.can_decide;
    if (!permitted) {
      setGuidanceMessage(entry.reviewer_name ? `该证据正在由 ${entry.reviewer_name} 审核` : "当前账号不能审核这条进展");
      return;
    }
    setReviewBusy(entry.id);
    setGuidanceMessage("");
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, action, note, guidance }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "指导意见保存失败");
      setGuidanceMessage(action === "start_review" ? "已接手，可以审核这条进展。" : action === "release_review" ? "已释放审核。" : payload.message || "审核结果已保存。");
      if (action === "substantive" || action === "supporting") {
        setProgressFilter("all");
        setSelectedId(entry.id);
        window.history.replaceState(null, "", `#progress-${entry.id}`);
      }
      await load();
    } catch (reviewError) {
      setGuidanceMessage(reviewError instanceof Error ? reviewError.message : "指导意见保存失败");
    } finally {
      setReviewBusy(null);
    }
  }


  const progress = useMemo(() => {
    const entries = [...(student?.progress ?? [])];
    const ids = new Set(entries.map((item) => item.id));
    // The dashboard has a shared history limit; keep the student's older imported summaries accessible.
    for (const item of meetingSummaries) {
      if (ids.has(item.progress_entry_id)) continue;
      entries.push({ id: item.progress_entry_id, kind: "AI 纪要", title: item.title, summary: item.summary, evidence: item.evidence,
        submitted_at: item.submitted_at, current_revision: item.current_revision, review_status: item.review_status,
        assessment: item.assessment, reviewer_note: item.reviewer_note, ai_summary_origin: true, summary_only: true,
        status: item.assessment ?? (item.review_status === "changes_requested" ? "supplement" : item.review_status === "rejected" ? "rejected" : "pending"),
        reviewer_name: null, reviewed_at: null, literature_ref: "", git_url: "", paper: null, project: null, attachments: [], evidence_sources: [], audit: [] });
    }
    return entries.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at) || b.id - a.id);
  }, [student, meetingSummaries]);
  const pendingCount = progress.filter(isPending).length;
  const activeGuidance = useMemo(() => [...guidanceNotes].sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || Number(Boolean(b.student_reported_at)) - Number(Boolean(a.student_reported_at)) || b.created_at.localeCompare(a.created_at)), [guidanceNotes]);
  const openGuidanceCount = guidanceNotes.filter((note) => note.status === "open").length;
  const visibleProgress = progress.filter((entry) => progressFilter === "all" || (progressFilter === "pending" && isPending(entry)) || (progressFilter === "ai" && entry.ai_summary_origin) || (progressFilter === "returned" && ["changes_requested", "rejected"].includes(entry.review_status)));
  const entry = visibleProgress.find((item) => item.id === selectedId) ?? visibleProgress[0];
  const ready = Boolean(student);

  useEffect(() => {
    if (!ready) return;
    function followHash() {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      const match = /^(?:review-progress|progress)-(\d+)$/.exec(hash);
      if (match) {
        setTab("progress"); setProgressFilter("all"); setSelectedId(Number(match[1]));
      } else if (hash.startsWith("guidance")) {
        setTab("guidance");
      } else if (["papers", "outputs", "proposal", "workflow", "audit", "milestones"].includes(hash) || hash.startsWith("milestone-")) {
        setTab("research");
      } else {
        setTab("progress"); setProgressFilter(hash === "ai-summaries" ? "ai" : hash === "formal-review" ? "pending" : "all");
      }
      setFocusTarget(hash);
    }
    followHash();
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
  }, [ready]);

  useEffect(() => {
    if (!focusTarget || loading) return;
    const timer = window.setTimeout(() => {
      const target = document.getElementById(focusTarget.replace("review-progress-", "progress-")) ?? document.getElementById(`sw-${tab}`);
      if (!target) return;
      let ancestor: HTMLElement | null = target;
      while (ancestor) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      target.scrollIntoView({ block: "nearest" });
      target.focus({ preventScroll: true });
      setFocusTarget("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusTarget, loading, tab, entry?.id]);

  function switchTab(next: typeof tab) {
    setTab(next); setFocusTarget("");
    window.history.replaceState(null, "", `#${next === "progress" ? "evidence" : next === "guidance" ? "guidance" : "papers"}`);
  }

  function writeGuidance() {
    switchTab("guidance"); setComposeOpen(true); setFocusTarget("guidance-compose");
  }

  if (loading && !student) return <main className="student-workspace"><Link href="/">← 返回首页</Link><h1>学生档案</h1><p role="status">正在加载学生档案…</p></main>;
  if (!student) return <main className="student-workspace"><Link href="/">← 返回首页</Link><h1>学生档案</h1><p role="alert">{error || "学生不存在"}</p><button onClick={() => void load()}>重新加载</button></main>;
  const draft = entry ? guidanceDraft(entry) : null;
  const imported = meetingSummaries.find((item) => item.progress_entry_id === entry?.id);
  const followUpNotice = entry ? progressFollowUpNotice(entry, new Date()) : null;

  return <main className="student-workspace">
    <nav className="sw-breadcrumb"><Link href="/?mentorView=students">← 返回学生列表</Link><span>探研 / 学生档案</span></nav>
    <header className="sw-profile">
      <div className="sw-identity"><span className="sw-avatar" aria-hidden="true">{student.name.slice(-2)}</span><div><div className="sw-name"><h1>{student.name}</h1><span>{student.gradeYear} 级{student.degree}</span>{student.stage && student.stage !== "待确认" ? <span>{student.stage}</span> : null}</div><p>{student.currentFocus && !["待补充", "尚未填写"].includes(student.currentFocus) ? student.currentFocus : "研究方向尚未填写"}</p></div></div>
      <div className="sw-profile-actions"><span>最近确认进展<strong>{student.lastSubstantiveAt ? dateText(student.lastSubstantiveAt) : "暂无"}</strong></span><button className="primary" onClick={writeGuidance}>写指导</button></div>
    </header>
    <nav className="sw-tabs" aria-label="学生档案页面">
      <button aria-current={tab === "progress" ? "page" : undefined} onClick={() => switchTab("progress")}>进展与审核{pendingCount ? <span>{pendingCount} 待审</span> : null}</button>
      <button aria-current={tab === "guidance" ? "page" : undefined} onClick={() => switchTab("guidance")}>指导{openGuidanceCount ? <span>{openGuidanceCount} 进行中</span> : null}</button>
      <button aria-current={tab === "research" ? "page" : undefined} onClick={() => switchTab("research")}>研究资料</button>
    </nav>
    {error ? <p className="sw-message" role="alert">{error} <button onClick={() => void load()}>重试</button></p> : null}
    {guidanceMessage ? <p className="sw-message" role="status">{guidanceMessage}</p> : null}

    <section id="sw-progress" tabIndex={-1} hidden={tab !== "progress"} aria-label="进展与审核">
      <div className="sw-filterbar"><div className="sw-filters" aria-label="筛选进展">{([["pending", "待审核", pendingCount], ["all", "全部", progress.length], ["ai", "AI 纪要", progress.filter((item) => item.ai_summary_origin).length], ["returned", "已退回", progress.filter((item) => ["changes_requested", "rejected"].includes(item.review_status)).length]] as const).map(([value, label, count]) => <button key={value} aria-pressed={progressFilter === value} onClick={() => { setProgressFilter(value); setSelectedId(null); }}>{label}<span>{count}</span></button>)}</div><span className="sw-muted">按提交时间排序</span></div>
      <div className="sw-progress-layout">
        <aside className="sw-records" aria-label="进展列表">
          {visibleProgress.map((item) => <button className="sw-record" key={item.id} aria-pressed={entry?.id === item.id} onClick={() => { setSelectedId(item.id); window.history.replaceState(null, "", `#progress-${item.id}`); }}><span className="sw-record-meta"><span>{item.ai_summary_origin ? "AI 纪要" : item.kind}</span><time>{dateText(item.submitted_at)}</time></span><strong>{item.title}</strong><p>{item.summary}</p><span className={`status-pill review-${item.review_status}`}>{reviewLabels[item.review_status]}</span></button>)}
          {!visibleProgress.length ? <p className="sw-empty">{progressFilter === "pending" ? "待审核已处理完" : "暂无这类记录"}</p> : null}
          {canManageAiRecords ? <DeletedAiRecords studentId={studentId} onChanged={load} refreshKey={aiRefreshKey} /> : null}
        </aside>
        {entry && draft ? <article className="sw-reader" key={entry.id} id={`progress-${entry.id}`} tabIndex={-1}>
          <header className="sw-reader-head"><div><div className="sw-reader-meta"><span className={`status-pill review-${entry.review_status}`}>{reviewLabels[entry.review_status]}</span><span>{entry.ai_summary_origin ? "AI 纪要" : entry.kind} · {dateText(entry.submitted_at)}</span></div><h2>{entry.title}</h2>{entry.paper ? <p className="sw-muted">{paperStageMeta[entry.paper.stage].label} · {entry.paper.manuscript_version}</p> : null}</div>{entry.ai_summary_origin && canManageAiRecords ? <AiRecordActions record={entry} onChanged={load} /> : null}</header>
          {isPending(entry) ? <div className="sw-review-bar" aria-label="审核操作">
            {entry.can_decide ? <div className="student-formal-binary"><button className="primary" disabled={reviewBusy === entry.id} onClick={() => void reviewProgress(entry, "substantive")}>{reviewBusy === entry.id ? "处理中…" : "确认进展"}</button><button disabled={reviewBusy === entry.id} aria-expanded={draft.open} onClick={() => updateGuidanceDraft(entry, { open: !draft.open })}>退回补充</button></div> : entry.can_finalize && (entry.review_status === "submitted" || entry.claim_stale) ? <button className="primary" disabled={reviewBusy === entry.id} onClick={() => void reviewProgress(entry, "start_review")}>{entry.claim_stale ? "重新接手审核" : "接手审核"}</button> : <span>{entry.reviewer_name ? `${entry.reviewer_name} 正在审核` : "当前账号无审核权限"}</span>}
            {entry.can_decide || entry.can_release ? <details className="sw-review-more"><summary>更多操作</summary><div><label>审核备注<textarea rows={3} maxLength={3000} value={reviewNotes[entry.id] || ""} onChange={(event) => setReviewNotes((current) => ({ ...current, [entry.id]: event.target.value }))} placeholder="判定为非进展时，请说明理由" /></label><div className="sw-actions">{entry.can_decide ? <><button disabled={reviewBusy === entry.id} onClick={() => void reviewProgress(entry, "supporting")}>记为支持性工作</button><button disabled={reviewBusy === entry.id || !(reviewNotes[entry.id] || "").trim()} onClick={() => void reviewProgress(entry, "rejected")}>判定为非进展</button></> : null}{entry.can_finalize && entry.review_status === "submitted" ? <button disabled={reviewBusy === entry.id} onClick={() => void reviewProgress(entry, "start_review")}>接手审核</button> : null}{entry.can_release ? <button disabled={reviewBusy === entry.id} onClick={() => void reviewProgress(entry, "release_review")}>释放审核</button> : null}</div></div></details> : null}
          </div> : null}
          {draft.open && isPending(entry) && entry.can_decide ? <div className="sw-return-form">
            <h3>退回补充</h3><label>需要修改什么<textarea rows={3} maxLength={3000} value={reviewNotes[entry.id] || ""} onChange={(event) => setReviewNotes((current) => ({ ...current, [entry.id]: event.target.value }))} /></label>
            <div className="sw-form-grid"><label>学生下一步<textarea rows={2} maxLength={800} value={draft.nextAction} onChange={(event) => updateGuidanceDraft(entry, { nextAction: event.target.value })} /></label><label>完成标准<textarea rows={2} maxLength={1200} value={draft.acceptanceCriteria} onChange={(event) => updateGuidanceDraft(entry, { acceptanceCriteria: event.target.value })} /></label><label>完成期限（可选）<input type="date" value={draft.dueDate} onChange={(event) => updateGuidanceDraft(entry, { dueDate: event.target.value })} /></label></div>
            <div className="sw-actions"><button className="primary" disabled={reviewBusy === entry.id || !(reviewNotes[entry.id] || "").trim() || !draft.nextAction.trim() || !draft.acceptanceCriteria.trim()} onClick={() => void reviewProgress(entry, "supplement", { nextAction: draft.nextAction, dueDate: draft.dueDate, acceptanceCriteria: draft.acceptanceCriteria })}>{reviewBusy === entry.id ? "发送中…" : "退回并发送指导"}</button><button onClick={() => updateGuidanceDraft(entry, { open: false })}>取消</button></div>
          </div> : null}
          <section className="sw-record-body"><h3>本次进展</h3><p>{entry.summary || "尚未填写"}</p>{entry.evidence ? <><h3>证据说明</h3><p>{entry.evidence}</p></> : null}</section>
          {followUpNotice ? <p className="sw-message">{followUpNotice}</p> : null}
          {entry.paper || entry.project ? <div className="sw-next-step">{entry.paper ? <div><span>论文下一步</span><p>{entry.paper.next_action || "尚未填写"}{entry.paper.next_action_due_date ? <small>期限 {entry.paper.next_action_due_date}</small> : null}</p>{entry.paper.blocker ? <p className="sw-blocker">需要协助：{entry.paper.blocker}</p> : null}</div> : null}{entry.project ? <div><span>课题下一行动</span><p>{entry.project.next_action || "尚未填写"}{entry.project.next_action_due_date ? <small>期限 {entry.project.next_action_due_date}</small> : null}</p><small>关联课题节点：{entry.project.milestone_title || "未关联"}{entry.project.milestone_target_date ? ` · ${entry.project.milestone_target_date}` : ""}</small>{entry.project.blocker ? <p className="sw-blocker">需要协助：{entry.project.blocker}</p> : null}</div> : null}</div> : null}
          {entry.attachments.length || entry.evidence_sources.some((source) => source.source_type !== "attachment") ? <section className="sw-materials"><h3>相关材料</h3>{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url} target="_blank" rel="noreferrer"><span>{attachment.file_name}</span><small>{(attachment.size_bytes / 1024 / 1024).toFixed(1)} MB ↗</small></a>)}{entry.evidence_sources.filter((source) => source.source_type !== "attachment").map((source) => <div key={source.id}>{source.source_ref && ["git", "url"].includes(source.source_type) ? <a href={source.source_ref} target="_blank" rel="noreferrer">{source.label} ↗</a> : <span>{source.label}{source.source_ref ? ` · ${source.source_ref}` : ""}</span>}</div>)}</section> : <p className="sw-muted sw-materials">{entry.summary_only ? "历史纪要的来源信息见下方记录详情" : "未附材料"}</p>}
          {entry.reviewer_note || entry.assessment ? <section className="sw-feedback"><h3>审核结果</h3>{entry.assessment ? <span>{entry.assessment === "substantive" ? "实质性进展" : "支持性工作"}{entry.reviewer_name ? ` · ${entry.reviewer_name}` : ""}</span> : null}{entry.reviewer_note ? <p>{entry.reviewer_note}</p> : null}</section> : null}
            {!entry.summary_only && entry.review_status === "changes_requested" && (viewerRole === "superadmin" || viewerRole === "admin" || viewerRole === "student") ? <details className="student-resubmit"><summary>补充证据并重新提交</summary><form onSubmit={(event) => void resubmitProgress(event, entry)}><label>更新后的结论<textarea name="summary" rows={3} required defaultValue={entry.summary} /></label><label>补充核验证据<textarea name="evidence" rows={3} required defaultValue={entry.evidence} /></label>{entry.kind === "文献" ? <label>论文题目 / DOI<input name="literatureRef" required defaultValue={entry.literature_ref} /></label> : <input type="hidden" name="literatureRef" value={entry.literature_ref || ""} />}{entry.paper ? <><input type="hidden" name="paperId" value={entry.paper.id} /><input name="gitUrl" type="hidden" value={entry.git_url || ""} /><label>论文阶段<select name="paperStage" defaultValue={entry.paper.stage}>{paperStages.map((stage) => <option key={stage} value={stage}>{paperStageMeta[stage].label}</option>)}</select></label><label>稿件版本<input name="manuscriptVersion" required defaultValue={entry.paper.manuscript_version} /></label><label>下一行动<textarea name="nextAction" rows={2} required defaultValue={entry.paper.next_action} /></label><label>行动期限<input name="nextActionDueDate" type="date" required defaultValue={entry.paper.next_action_due_date} /></label><label>当前阻塞（可选）<textarea name="blocker" rows={2} defaultValue={entry.paper.blocker} /></label><label>稿件编号 / DOI（可选）<input name="submissionIdentifier" defaultValue={entry.paper.submission_identifier} /></label></> : <label>Git 链接（可选）<input name="gitUrl" type="url" defaultValue={entry.git_url} placeholder="仅支持 https://" /></label>}<label>补充附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件，单个不超过 50 MB，总计不超过 80 MB</small></label>{progressMessage[entry.id] ? <p role="status">{progressMessage[entry.id]}</p> : null}<button className="primary" disabled={progressBusy === entry.id}>{progressBusy === entry.id ? "提交中…" : "保留原记录并重新提交"}</button></form></details> : null}
          <details className="sw-record-history"><summary>记录详情与操作记录</summary><div className="sw-detail-body"><p>记录 #{entry.id} · 第 {entry.current_revision} 版{entry.reviewed_at ? ` · 审核于 ${dateText(entry.reviewed_at)}` : ""}</p>{entry.paper?.title && entry.paper.title !== entry.title ? <DetailBlock label="所属论文" value={entry.paper.title} /> : null}{entry.paper?.submission_identifier ? <DetailBlock label="稿件编号 / DOI" value={entry.paper.submission_identifier} /> : null}{entry.literature_ref ? <DetailBlock label="文献" value={entry.literature_ref} /> : null}{entry.git_url ? <a href={entry.git_url} target="_blank" rel="noreferrer">代码仓库 ↗</a> : null}{imported ? <><DetailBlock label="纪要来源" value={imported.source_label || "飞书智能纪要"} /><DetailBlock label="导入说明" value={imported.detected_reason} /><p>纪要时间 {dateText(imported.message_created_at)} · 保存于 {dateText(imported.saved_at)}</p>{imported.summary !== entry.summary ? <DetailBlock label="原始纪要" value={imported.summary} /> : null}</> : null}{entry.attachments.map((attachment) => <p className="sw-fingerprint" key={attachment.id}>{attachment.file_name} · SHA256 {attachment.content_sha256}</p>)}{entry.evidence_sources.filter((source) => source.content_sha256).map((source) => <p className="sw-fingerprint" key={source.id}>{source.label} · SHA256 {source.content_sha256}</p>)}{entry.audit.map((event) => <div className="sw-audit-row" key={event.id}><strong>{event.actor_name || (event.actor_type === "system" ? "系统" : "未知人员")} · {reviewLabels[event.to_status as ReviewStatus] || event.action}</strong><small>{dateText(event.created_at)}</small>{event.note ? <p>{event.note}</p> : null}</div>)}</div></details>
        </article> : <div className="sw-reader sw-empty-state"><span aria-hidden="true">✓</span><h2>{progressFilter === "pending" ? "当前没有待审核进展" : "暂无记录"}</h2><p>{progressFilter === "pending" ? "可以查看历史进展，或给学生写一条指导。" : "学生提交或导入的记录会显示在这里。"}</p><div className="sw-actions"><button onClick={() => setProgressFilter("all")}>查看全部进展</button><button onClick={writeGuidance}>写指导</button></div></div>}
      </div>
    </section>

    <section id="sw-guidance" tabIndex={-1} hidden={tab !== "guidance"} className="sw-panel" aria-label="指导">
      <header className="sw-section-head" id="guidance"><div><h2>指导记录</h2><p>{openGuidanceCount} 项进行中 · {guidanceNotes.length - openGuidanceCount} 项已完成</p></div><button onClick={() => { setComposeOpen(!composeOpen); if (!composeOpen) setFocusTarget("guidance-compose"); }}>{composeOpen ? "收起表单" : "写指导"}</button></header>
      <form id="guidance-compose" tabIndex={-1} hidden={!composeOpen} className="sw-compose" onSubmit={createGuidance}>
        <input name="guidanceType" type="hidden" value="general" /><label>指导内容<textarea name="content" rows={4} required maxLength={3000} placeholder="写下研究建议或需要学生完成的事" /></label>
        <div className="sw-form-grid"><label>下一步（可选）<input name="nextAction" maxLength={800} /></label><label>完成期限（可选）<input name="dueDate" type="date" /></label></div>
        <details><summary>主题、关联纪要与验收设置</summary><div className="sw-form-grid"><label>指导主题（可选）<input name="title" maxLength={200} /></label><label>关联 AI 纪要<select name="sourceProgressEntryId" defaultValue=""><option value="">不关联</option>{meetingSummaries.map((item) => <option key={item.progress_entry_id} value={item.progress_entry_id}>{dateText(item.message_created_at)} · {item.title}</option>)}</select></label><label>完成确认方式<select name="verificationMode" defaultValue="self_report"><option value="self_report">学生自行确认完成</option><option value="mentor_verify">学生提交，导师验收</option></select></label><label>验收标准<textarea name="acceptanceCriteria" rows={2} maxLength={1200} placeholder="需要导师验收时，请写清完成标准" /></label></div></details>
        <div className="sw-actions"><button className="primary" disabled={guidanceSaveBusy}>{guidanceSaveBusy ? "保存中…" : "保存指导"}</button><button type="button" onClick={() => setComposeOpen(false)}>收起</button></div>
      </form>
      <div className="sw-guidance-list">{activeGuidance.map((note) => <details key={note.id} id={`guidance-${note.id}`} tabIndex={-1}><summary><span className={`sw-guidance-status ${note.status}`}>{note.status === "completed" ? "已完成" : note.student_reported_at ? "待验收" : "进行中"}</span><div><strong>{note.title || note.next_action || note.content.split("\n")[0]}</strong><small>{note.mentor_name} · {dateText(note.created_at)}{note.due_date && note.status === "open" ? ` · 期限 ${note.due_date}` : ""}</small></div></summary><div className="sw-detail-body"><p>{note.content}</p>{note.next_action ? <DetailBlock label="下一步" value={note.next_action} /> : null}{note.due_date ? <DetailBlock label="完成期限" value={note.due_date} /> : null}{note.acceptance_criteria ? <DetailBlock label="验收标准" value={note.acceptance_criteria} /> : null}<p className="sw-muted">{note.status === "open" ? note.student_reported_at ? "学生已提交完成说明，等待验收" : note.acknowledged_at ? `学生已于 ${dateText(note.acknowledged_at)} 确认收到` : "等待学生确认收到" : `${note.completed_by_name || "学生"}已完成 · ${dateText(note.completed_at)}`}</p>{note.completion_note ? <DetailBlock label="完成说明" value={note.completion_note} /> : null}<footer className="sw-guidance-footer"><span>{note.source_title ? <a href={`#progress-${note.source_progress_entry_id}`}>关联纪要：{note.source_title}</a> : note.verification_mode === "mentor_verify" ? "需导师验收" : "学生自行确认"}</span><button disabled={guidanceStatusBusy === note.id || (note.status === "open" && note.verification_mode === "mentor_verify" && !note.student_reported_at)} onClick={() => void updateGuidanceStatus(note, note.status === "open" ? "complete" : "reopen")}>{note.status === "completed" ? "重新打开" : note.student_reported_at ? "确认验收" : "标记完成"}</button></footer></div></details>)}{!guidanceNotes.length ? <p className="sw-empty">暂无指导记录。点击“写指导”即可添加。</p> : null}</div>
    </section>

    <section id="sw-research" tabIndex={-1} hidden={tab !== "research"} className="sw-research" aria-label="研究资料">
      <nav className="sw-research-nav" aria-label="研究资料目录"><a href="#papers">论文</a><a href="#proposal">课题与节点</a><a href="#outputs">成果</a></nav>
      <section className="sw-panel" id="papers" tabIndex={-1}><header className="sw-section-head"><h2>论文进展 <span>{papers.length}</span></h2></header>{papers.map((paper) => {
        const deadline = paper.status === "active" ? paperDeadlineState(paper.planned_submission_date, new Date(PAGE_REFERENCE_TIME)) : null;
        const latest = progress.find((item) => item.paper?.id === paper.id);
        return <details key={paper.id} className="sw-paper"><summary><div><strong>{paper.title}</strong><small>{paperStageMeta[paper.current_stage].label} · {paperStatusLabels[paper.status]}{paper.target_venue ? ` · ${paper.target_venue}` : ""}</small></div><span className={deadline?.overdue ? "sw-blocker" : "sw-muted"}>{deadline?.label || paperStatusLabels[paper.status]}</span></summary><div className="sw-detail-body"><DetailBlock label="下一步" value={latest?.paper?.next_action || "尚未填写"} />{latest?.paper?.next_action_due_date ? <DetailBlock label="行动期限" value={latest.paper.next_action_due_date} /> : null}{latest?.paper?.blocker ? <DetailBlock label="需要协助" value={latest.paper.blocker} /> : null}<DetailBlock label="本阶段要求" value={paperStageMeta[paper.current_stage].gate} />{paper.submission_identifier ? <DetailBlock label="稿件编号 / DOI" value={paper.submission_identifier} /> : null}<p className="sw-muted">{paper.paper_type} · 最近更新 {dateText(paper.latest_progress_at)} · {paper.pending_count} 条待审</p>{latest ? <a href={`#progress-${latest.id}`}>查看最近进展 →</a> : null}</div></details>;
      })}{!papers.length ? <p className="sw-empty">暂无已确认论文。待审论文可在“进展与审核”查看。</p> : null}</section>
      <section className="sw-panel" id="proposal" tabIndex={-1}><header className="sw-section-head"><div><h2>课题与节点</h2><p>{proposal ? proposalLabels[proposal.status] : "尚未建立研究方案"}</p></div><Link href={proposal ? `/?mentorView=research&researchTab=proposals&proposal=${proposal.id}` : "/?mentorView=research&researchTab=proposals"}>{proposal?.can_review && proposal.status === "submitted" ? "审核方案 →" : "管理方案 →"}</Link></header>{proposal ? <><h3>{proposal.title}</h3><details className="sw-proposal-details"><summary>查看研究方案</summary><div className="sw-detail-body"><DetailBlock label="科学问题" value={proposal.scientific_question} /><DetailBlock label="研究假设" value={proposal.hypothesis} /><DetailBlock label="研究目标" value={proposal.objectives} /><DetailBlock label="创新点" value={proposal.innovation} /><DetailBlock label="文献基础" value={proposal.literature_basis} /><DetailBlock label="技术路线" value={proposal.methodology} /><DetailBlock label="数据与伦理边界" value={proposal.data_ethics} /><DetailBlock label="风险与备选方案" value={proposal.risks} /><DetailBlock label="资源需求" value={proposal.resources} /><DetailBlock label="参考文献" value={proposal.references_text} />{proposal.reviewer_note ? <DetailBlock label="导师意见" value={proposal.reviewer_note} /> : null}</div></details></> : null}
        <div id="milestones" className="sw-milestones">{proposal?.milestones.map((milestone) => <article key={milestone.id} id={`milestone-${milestone.id}`} tabIndex={-1}><div><h3>{milestone.title}</h3><p>{milestone.evidence_target || "尚未填写完成标准"}</p><small>{milestone.target_date || "期限待定"} · {targetText(milestone.target_date, milestone.status)}</small></div>{proposal.status === "approved" && viewerRole !== "student" ? <select aria-label={`${milestone.title}状态`} value={milestone.status} disabled={milestoneBusy === milestone.id} onChange={(event) => void updateMilestone(milestone.id, event.target.value as MilestoneStatus)}>{Object.entries(milestoneLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <span>{milestoneLabels[milestone.status]}</span>}</article>)}{proposal && !proposal.milestones.length ? <p className="sw-empty">暂无培养节点。</p> : null}</div>
        {milestoneMessage ? <p role="status">{milestoneMessage}</p> : null}
        {proposal ? <details className="sw-record-history" id="audit" tabIndex={-1}><summary>方案版本与操作记录</summary><div className="sw-detail-body">{proposal.versions.map((version) => <p key={version.id}>第 {version.version_number} 版 · {version.submitted_by_name} · {dateText(version.created_at)}</p>)}{proposal.audit.map((event) => <div className="sw-audit-row" key={event.id}><strong>{auditLabels[event.action] || event.action}</strong><small>{event.actor_name} · {dateText(event.created_at)}</small><p>{event.detail}</p></div>)}{!proposal.versions.length && !proposal.audit.length ? <p>暂无版本或操作记录。</p> : null}</div></details> : null}
      </section>
    <section className="sw-panel student-output-panel" id="outputs">
        <div className="student-section-head"><div><h2>科研成果</h2><p>登记论文、数据、软件等成果。</p></div>{viewerRole === "superadmin" || viewerRole === "admin" ? <button className="student-output-add" type="button" onClick={() => setOutputOpen((current) => !current)}>{outputOpen ? "收起" : "＋ 登记成果"}</button> : <em>{outputs.length}</em>}</div>
      {outputOpen && (viewerRole === "superadmin" || viewerRole === "admin") ? <form className="student-output-form" onSubmit={createOutput}>
        <label>成果类型<select name="outputType" required defaultValue="paper">{Object.entries(outputTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>当前阶段<select name="lifecycleStatus" required defaultValue="planned">{Object.entries(outputLifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="wide">成果名称<input name="title" required maxLength={300} placeholder="论文、数据集、软件、专利或报告名称" /></label>
        <label>期刊 / 会议 / 发布位置<input name="venue" maxLength={300} placeholder="可选" /></label>
        <label>DOI / 专利号 / 仓库标识<input name="identifier" maxLength={500} placeholder="可选" /></label>
        <label>关联培养节点<select name="linkedMilestoneId" defaultValue=""><option value="">暂不关联</option>{proposal?.milestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title}</option>)}</select></label>
        <label>成果链接<input name="url" type="url" placeholder="仅支持 https://" /></label>
        <label className="wide">成果说明<textarea name="summary" rows={3} maxLength={4000} placeholder="说明成果贡献和当前状态" /></label>
        <div className="wide student-output-form-actions"><button className="primary" disabled={outputBusy}>{outputBusy ? "保存中…" : "保存成果"}</button></div>
      </form> : null}
      {outputMessage ? <p className="student-output-message" role="status">{outputMessage}</p> : null}
      <div className="student-output-grid">{outputs.map((output) => <article key={output.id}>
        <div><span>{outputTypeLabels[output.output_type]}</span>{viewerRole === "superadmin" || viewerRole === "admin" ? <select aria-label={`${output.title}成果阶段`} value={output.lifecycle_status} disabled={outputUpdateBusy === output.id} onChange={(event) => void updateOutputLifecycle(output, event.target.value as ResearchOutput["lifecycle_status"])}>{Object.entries(outputLifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <em className={output.lifecycle_status}>{outputLifecycleLabels[output.lifecycle_status]}</em>}</div>
        <h3>{output.title}</h3>
        <p>{output.summary || "尚未填写成果说明"}</p>
        <dl>{output.venue ? <div><dt>发布位置</dt><dd>{output.venue}</dd></div> : null}{output.identifier ? <div><dt>标识符</dt><dd>{output.identifier}</dd></div> : null}{output.milestone_title ? <div><dt>关联节点</dt><dd>{output.milestone_title}</dd></div> : null}</dl>
        {output.events.length ? <details className="student-output-events"><summary>变更记录（{output.events.length}）</summary>{output.events.map((event) => <div key={event.id}><strong>{event.detail}</strong><small>{event.actor_name} · {dateText(event.created_at)}</small></div>)}</details> : null}
        <footer><span>{output.created_by_name} · {dateText(output.updated_at)}</span>{output.url ? <a href={output.url} target="_blank" rel="noreferrer">打开成果 ↗</a> : null}</footer>
      </article>)}{!outputs.length ? <div className="student-empty">暂无成果记录。</div> : null}</div>
    </section>

    </section>
  </main>;
}
