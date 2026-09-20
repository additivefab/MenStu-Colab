"use client";

import { activeBlockerText } from "../lib/progress-blocker";
import { isCurrentResearchTrack } from "../lib/progress-track";
import { instantTimestamp } from "../lib/dashboard-overview/dates";

import { FormEvent, type Dispatch, type ReactNode, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paperDeadlineState, paperStageMeta, paperStages, paperTypes, type PaperStage } from "../lib/paper-progress";
import { ProgressResolutionPanel } from "../components/progress-resolution-panel";
import type { ProgressResolutionKind, ProgressResolutionStatus } from "../lib/progress-resolution";
import { AiRecordActions } from "../components/ai-record-actions";
import { MentorGroupOverview } from "../components/dashboard-overview/mentor-group-overview";
import { clearMutationKey, mutationKeyForForm } from "../lib/client-idempotency";

declare global {
  interface Window {
    h5sdk?: {
      ready(callback: () => void): void;
      error(callback: (error: unknown) => void): void;
    };
    tt?: {
      requestAccess(options: {
        appID: string;
        scopeList: string[];
        success(result: { code: string }): void;
        fail(error: unknown): void;
      }): void;
    };
  }
}

type RiskLevel = "正常" | "黄色" | "橙色" | "红色";
type StudentProjectProgress = {
  milestone_id: number | null;
  milestone_title: string;
  milestone_target_date: string | null;
  evidence_target: string;
  proposal_version: number | null;
  next_action: string;
  next_action_due_date: string;
  blocker: string;
  completion_requested: boolean;
};

type ProgressRevision = {
  id: number;
  revision_number: number;
  snapshot: Record<string, unknown>;
  review_status: "submitted" | "in_review" | "accepted" | "changes_requested" | "rejected";
  assessment: "substantive" | "supporting" | null;
  reviewer_note: string;
  reviewer_name: string | null;
  reviewed_at: string | null;
  created_at: string;
};

type StudentProgress = {
  id: number;
  kind: string;
  title: string;
  summary: string;
  evidence: string;
  literature_ref: string;
  git_url: string;
  status: "pending" | "substantive" | "supporting" | "supplement" | "rejected";
  review_status: "submitted" | "in_review" | "accepted" | "changes_requested" | "rejected";
  assessment: "substantive" | "supporting" | null;
  reviewer_note: string;
  reviewer_name: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  current_revision: number;
  follow_up_states?: Partial<Record<ProgressResolutionKind, ProgressResolutionStatus>>;
  ai_summary_origin: boolean;
  can_delete_ai?: boolean;
  paper: {
    id: number;
    title: string;
    paper_type: string;
    stage: PaperStage;
    target_venue: string;
    planned_submission_date: string | null;
    submission_identifier: string;
    manuscript_version: string;
    next_action: string;
    next_action_due_date: string;
    blocker: string;
  } | null;
  project: StudentProjectProgress | null;
  attachments: Array<{
    id: number;
    file_name: string;
    content_type: string;
    size_bytes: number;
    content_sha256: string;
    download_url: string;
    revision_number: number;
  }>;
  evidence_sources: Array<{
    id: number;
    source_type: string;
    label: string;
    source_ref: string;
    content_sha256: string;
    revision_number: number;
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
  revisions: ProgressRevision[];
};

type StudentPaper = {
  id: number;
  student_id: string;
  student_name: string;
  title: string;
  paper_type: string;
  target_venue: string;
  planned_submission_date: string | null;
  current_stage: PaperStage;
  submission_identifier: string;
  status: "active" | "on_hold" | "accepted" | "published" | "closed";
  latest_progress_at: string | null;
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
  proposalStatus: ProposalStatus | null;
  proposalTitle: string | null;
  proposalVersion: number | null;
  nextMilestone: string | null;
  nextMilestoneDate: string | null;
  outputCount: number;
  risk: { level: RiskLevel; days: number };
  progress: StudentProgress[];
  milestones: StudentMilestone[];
};

type PendingEntry = {
  id: number;
  student_id: string;
  display_name: string;
  kind: string;
  title: string;
  summary: string;
  evidence: string;
  literature_ref: string;
  git_url: string;
  review_status: "submitted" | "in_review";
  reviewer_name: string | null;
  reviewed_by_user_id: number | null;
  submitted_by_user_id: number | null;
  review_claimed_at: string | null;
  paper: StudentProgress["paper"];
  project: StudentProgress["project"];
  current_revision: number;
  ai_summary_origin: boolean;
  can_delete_ai?: boolean;
  revisions: ProgressRevision[];
  can_finalize: boolean;
  can_decide: boolean;
  can_release: boolean;
  claim_stale: boolean;
  evidence_sources: StudentProgress["evidence_sources"];
  attachments: StudentProgress["attachments"];
  submitted_at: string;
};

type ReviewGuidance = {
  nextAction: string;
  dueDate: string;
  acceptanceCriteria: string;
};

type ProposalStatus = "draft" | "submitted" | "changes_requested" | "approved";
type MilestoneStatus = "pending" | "in_progress" | "completed" | "blocked";

type ProposalMilestone = {
  id: number;
  proposal_id: number;
  title: string;
  target_date: string;
  evidence_target: string;
  status: MilestoneStatus;
  sort_order: number;
  updated_at: string;
};

type StudentMilestone = {
  id: number;
  proposal_id: number;
  student_id: string;
  proposal_title: string;
  proposal_status: ProposalStatus;
  proposal_version: number;
  title: string;
  target_date: string;
  evidence_target: string;
  status: MilestoneStatus;
  sort_order: number;
  updated_at: string;
};

type ResearchProposal = {
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
  can_review: boolean;
  milestones: ProposalMilestone[];
  versions: Array<{ id: number; version_number: number; created_at: string; submitted_by_name: string }>;
  audit: Array<{ id: number; action: string; detail: string; created_at: string; actor_name: string }>;
};

type FeishuMeetingImport = {
  id: number;
  message_type: string;
  extracted_text: string;
  detected_reason: string;
  status: "pending" | "confirmed";
  message_created_at: string;
  received_at: string;
  links: Array<{
    id: number;
    student_id: string;
    student_name: string;
    progress_entry_id: number;
    created_at: string;
  }>;
};

type MeetingRequest = {
  id: number;
  student_id: string;
  student_name: string;
  preferred_date: string;
  preferred_time: string;
  duration_minutes: number;
  topic: string;
  note: string;
  status: "requested" | "confirmed" | "declined" | "cancelled";
  response_note: string;
  requested_by_user_id: number;
  requested_by_name: string;
  handled_by_user_id: number | null;
  handled_by_name: string | null;
  handled_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
};

type MeetingAgenda = {
  id: number;
  mentor_user_id: number;
  mentor_name: string;
  title: string;
  meeting_date: string | null;
  status: "draft" | "scheduled" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
  items: Array<{
    id: number;
    agenda_id: number;
    student_id: string;
    student_name: string;
    topic: string;
    reason: string;
    duration_minutes: number;
    sort_order: number;
    status: "open" | "resolved";
  }>;
};

type NotificationDelivery = {
  id: number;
  student_id: string;
  student_name: string;
  reason: string;
  status: "sending" | "sent" | "failed";
  error_message: string;
  sent_at: string | null;
  created_at: string;
};

type StudentGuidanceNote = {
  id: number;
  student_id: string;
  title: string;
  content: string;
  next_action: string;
  due_date: string | null;
  acceptance_criteria: string;
  verification_mode: "self_report" | "mentor_verify";
  status: "open" | "completed";
  mentor_name: string;
  acknowledged_at: string | null;
  student_reported_at: string | null;
  mentor_verified_at: string | null;
  completed_at: string | null;
  completed_by_name: string | null;
  completion_note: string;
  version: number;
  created_at: string;
  events: Array<{
    id: number;
    actor_type: "staff" | "student" | "system";
    actor_name: string | null;
    action: "created" | "acknowledged" | "completed" | "reopened";
    note: string;
    created_at: string;
  }>;
};

type ViewerRole = "superadmin" | "admin" | "student";

type DashboardData = {
  viewer: {
    id: number;
    name: string;
    avatarUrl: string;
    role: ViewerRole;
    primaryRole: ViewerRole;
    activePersona: "management" | "student";
    canSwitchPersona: boolean;
    studentId: string | null;
  };
  students: Student[];
  papers: StudentPaper[];
  pending: PendingEntry[];
  workflowTasks: Array<{
    id: number;
    type: "proposal_review" | "blocked_milestone" | "overdue_milestone" | "guidance_verification" | "resolution_verification";
    studentId: string;
    studentName: string;
    title: string;
    detail: string;
    targetDate: string | null;
    context?: string;
    nextAction?: string;
    acceptanceCriteria?: string;
    version?: number;
    progressEntryId?: number;
  }>;
  studentNextAction?: {
    primary: {
      id: string;
      kind: "supplement" | "guidance" | "paper" | "project" | "meeting" | "waiting" | "onboarding" | "resolution";
      destination: "supplement" | "guidance" | "paper" | "project" | "meeting" | "progress" | "resolution";
      kicker: string;
      title: string;
      detail: string;
      meta: string;
      targetId?: number;
      itemKind?: ProgressResolutionKind;
      attention: boolean;
      waiting: boolean;
    } | null;
    additionalActionCount: number;
    waitingCount: number;
  } | null;
  metrics: {
    total: number;
    doctors: number;
    masters: number;
    pending: number;
    waiting: number;
    proposalPending: number;
    guidancePending: number;
    resolutionPending?: number;
    blocked: number;
    outputs: number;
    attention: number;
    riskCounts: Record<string, number>;
  };
};

type AuthGate = {
  kind: "required" | "pending" | "setup";
  message: string;
};

const navItems = [
  { id: "overview", label: "全组进度", icon: "◫" },
  { id: "inbox", label: "待我处理", icon: "✓" },
  { id: "students", label: "学生", icon: "◎" },
  { id: "research", label: "论文与课题", icon: "◇" },
  { id: "meetings", label: "组会", icon: "▣" },
  { id: "cohort", label: "课题组", icon: "▦" },
  { id: "settings", label: "系统管理", icon: "⚙" },
] as const;

type MentorView = (typeof navItems)[number]["id"];

function mentorViewFromUrl(): MentorView {
  if (typeof window === "undefined") return "overview";
  const params = new URL(window.location.href).searchParams;
  const requested = params.get("mentorView") ?? (params.get("view") === "overview" ? "overview" : null);
  return navItems.some((item) => item.id === requested) ? requested as MentorView : "overview";
}

function dashboardQueryFromUrl() {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get("q") ?? "";
}

const progressKinds = ["文献", "实验", "算法", "数据", "论文", "复现", "项目", "组会"];

const proposalStatusMeta: Record<ProposalStatus, { label: string; hint: string }> = {
  draft: { label: "草稿", hint: "仅本人和管理员可见" },
  submitted: { label: "待导师审核", hint: "当前版本暂时锁定" },
  changes_requested: { label: "需要修改", hint: "按导师意见形成新版本" },
  approved: { label: "已确认", hint: "当前方案已冻结执行" },
};

const milestoneStatusLabels: Record<MilestoneStatus, string> = {
  pending: "未开始",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "受阻",
};

function shortDate(value: string | null) {
  if (!value) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function sinceText(days: number) {
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前`;
}

function fileSizeText(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function progressRevisionTime(entry: StudentProgress) {
  const value = entry.revisions?.find((revision) => revision.revision_number === entry.current_revision)?.created_at ?? entry.submitted_at;
  return instantTimestamp(value);
}

function currentStudentEntry(entry: StudentProgress, student: Student, papers: StudentPaper[] = []) {
  return isCurrentResearchTrack({ paperId: entry.paper?.id, milestoneId: entry.project?.milestone_id, proposalVersion: entry.project?.proposal_version }, {
    proposal: student.proposalVersion != null ? { status: student.proposalStatus ?? "draft", version: student.proposalVersion } : null,
    papers,
    milestones: student.milestones,
  });
}

function daysSinceLatestSubmission(student: Student) {
  const latest = student.progress.reduce((value, entry) => Math.max(value, progressRevisionTime(entry)), 0);
  if (!latest) return student.risk.days;
  return Math.max(0, Math.floor((Date.now() - latest) / 86_400_000));
}

function daysSinceSubstantiveProgress(student: Student) {
  if (!student.lastSubstantiveAt) return student.risk.days;
  const timestamp = new Date(student.lastSubstantiveAt).getTime();
  if (!Number.isFinite(timestamp)) return student.risk.days;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [viewer, setViewer] = useState<DashboardData["viewer"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<MentorView>("overview");
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"全部" | RiskLevel>("全部");
  const [degreeFilter, setDegreeFilter] = useState<"全部" | Student["degree"]>("全部");
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<number | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [meetingRequests, setMeetingRequests] = useState<MeetingRequest[]>([]);
  const [meetingLoadError, setMeetingLoadError] = useState("");
  const [toast, setToast] = useState("");
  const [overviewRefreshRequest, setOverviewRefreshRequest] = useState(0);
  const [authGate, setAuthGate] = useState<AuthGate | null>(null);
  const [personaBusy, setPersonaBusy] = useState(false);
  const globalSearchRef = useRef<HTMLInputElement>(null);

  const navigateMentor = useCallback((next: MentorView, replace = false) => {
    setView(next);
    if (next === "overview") setError("");
    const url = new URL(window.location.href);
    const sameDestination = mentorViewFromUrl() === next;
    url.searchParams.set("mentorView", next);
    if (next !== "research") {
      url.searchParams.delete("researchTab");
      url.searchParams.delete("proposal");
    }
    window.history[replace || sameDestination ? "replaceState" : "pushState"]({}, "", url);
  }, []);

  const switchPersona = useCallback(async (persona: "management" | "student") => {
    setPersonaBusy(true);
    try {
      const response = await fetch("/api/auth/persona", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "界面切换失败");
      window.location.assign(persona === "student" ? "/" : "/?mentorView=overview");
    } catch (switchError) {
      setToast(switchError instanceof Error ? switchError.message : "界面切换失败");
      setPersonaBusy(false);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      setError("");
      const [response, meetingResponse] = await Promise.all([
        fetch("/api/dashboard", { cache: "no-store" }),
        fetch("/api/meeting-requests", { cache: "no-store" }).catch(() => null),
      ]);
      const payload = (await response.json()) as DashboardData & { code?: string; error?: string };
      if (response.status === 401) {
        setAuthGate({ kind: "required", message: payload.error || "请使用飞书登录" });
        return;
      }
      if (response.status === 403 && payload.code === "FEISHU_ACCOUNT_PENDING") {
        setAuthGate({ kind: "pending", message: payload.error || "账号等待系统授权" });
        return;
      }
      if (response.status === 503 && payload.code === "FEISHU_NOT_CONFIGURED") {
        setAuthGate({ kind: "setup", message: payload.error || "飞书应用尚未配置" });
        return;
      }
      if (!response.ok) throw new Error(payload.error || "加载失败");
      setAuthGate(null);
      setData(payload);
      setViewer(payload.viewer);
      if (payload.viewer.role !== "student") {
        if (!meetingResponse) {
          setMeetingLoadError("预约服务暂时不可用");
        } else {
          const meetingPayload = await meetingResponse.json().catch(() => ({ error: "预约服务返回了无法识别的响应" })) as { requests?: MeetingRequest[]; error?: string };
          if (meetingResponse.ok && !meetingPayload.error) {
            setMeetingRequests(meetingPayload.requests ?? []);
            setMeetingLoadError("");
          } else {
            setMeetingLoadError(meetingPayload.error || "预约读取失败");
          }
        }
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOverviewShell = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as {
        configured?: boolean;
        user?: {
          id: number;
          displayName: string;
          avatarUrl: string;
          role: ViewerRole | "pending";
          primaryRole: ViewerRole | "pending";
          activePersona: "management" | "student";
          canSwitchPersona: boolean;
          studentId: string | null;
        } | null;
      };
      if (response.status === 503 || payload.configured === false) {
        setAuthGate({ kind: "setup", message: "飞书应用尚未配置" });
        return;
      }
      if (response.status === 401 || !payload.user) {
        setAuthGate({ kind: "required", message: "请使用飞书登录" });
        return;
      }
      if (payload.user.role === "pending") {
        setAuthGate({ kind: "pending", message: "账号等待系统授权" });
        return;
      }
      if (payload.user.role === "student") {
        await loadDashboard();
        return;
      }
      if (!response.ok) throw new Error("登录状态读取失败");
      setAuthGate(null);
      setViewer({
        id: payload.user.id,
        name: payload.user.displayName,
        avatarUrl: payload.user.avatarUrl,
        role: payload.user.role,
        primaryRole: payload.user.primaryRole as ViewerRole,
        activePersona: payload.user.activePersona,
        canSwitchPersona: payload.user.canSwitchPersona,
        studentId: payload.user.studentId,
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "登录状态读取失败");
    } finally {
      setLoading(false);
    }
  }, [loadDashboard]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (mentorViewFromUrl() === "overview") void loadOverviewShell();
      else void loadDashboard();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard, loadOverviewShell]);

  useEffect(() => {
    if (view === "overview" || data || !viewer || viewer.role === "student" || loading) return;
    const timer = window.setTimeout(() => void loadDashboard(), 0);
    return () => window.clearTimeout(timer);
  }, [data, loadDashboard, loading, view, viewer]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setView(mentorViewFromUrl()); setQuery(dashboardQueryFromUrl()); }, 0);
    if (!new URL(window.location.href).searchParams.has("mentorView")) {
      const url = new URL(window.location.href);
      url.searchParams.set("mentorView", mentorViewFromUrl());
      window.history.replaceState({}, "", url);
    }
    const onPopState = () => { setView(mentorViewFromUrl()); setQuery(dashboardQueryFromUrl()); };
    window.addEventListener("popstate", onPopState);
    return () => { window.clearTimeout(timer); window.removeEventListener("popstate", onPopState); };
  }, []);

  useEffect(() => {
    if (viewer?.role !== "superadmin" && view === "settings") {
      const url = new URL(window.location.href);
      url.searchParams.set("mentorView", "overview");
      window.history.replaceState({}, "", url);
    }
  }, [view, viewer?.role]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    function focusGlobalSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        globalSearchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", focusGlobalSearch);
    return () => window.removeEventListener("keydown", focusGlobalSearch);
  }, []);

  const filteredStudents = useMemo(() => {
    if (!data) return [];
    const normalized = query.trim().toLowerCase();
    return data.students
      .filter((student) => riskFilter === "全部" || student.risk.level === riskFilter)
      .filter((student) => degreeFilter === "全部" || student.degree === degreeFilter)
      .filter((student) =>
        !normalized || `${student.name}${student.stage}${student.currentFocus}${student.degree}`.toLowerCase().includes(normalized),
      )
      .sort((a, b) => b.risk.days - a.risk.days);
  }, [data, degreeFilter, query, riskFilter]);

  async function review(entry: PendingEntry, action: string, guidance?: ReviewGuidance) {
    if (!entry.can_finalize) {
      setToast(entry.reviewer_name ? `该证据正在由 ${entry.reviewer_name} 审核` : "当前账号没有导师审核权限");
      return;
    }
    if ((action === "supplement" || action === "rejected") && !(reviewNotes[entry.id] || "").trim()) {
      setToast("退回补证或判定为非进展时，必须先填写具体理由");
      return;
    }
    if (guidance && (!guidance.nextAction.trim() || !guidance.acceptanceCriteria.trim())) {
      setToast("请填写学生下一步和可判断的完成标准");
      return;
    }
    setReviewBusy(entry.id);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, action, note: reviewNotes[entry.id] || "", guidance }),
      });
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "审核失败");
      setToast(guidance ? (result.message || "已退回并发送指导") : action === "start_review" ? (entry.claim_stale ? "已重新领取超时审核" : "已接手审核") : action === "release_review" ? "已释放审核" : action === "substantive" ? "已确认为实质性进展" : "审核结果已保存");
      await loadDashboard();
    } catch (reviewError) {
      setToast(reviewError instanceof Error ? reviewError.message : "审核失败");
    } finally {
      setReviewBusy(null);
    }
  }

  async function sendReminder(student: Student) {
    try {
      const response = await fetch("/api/feishu/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: student.id }),
      });
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "提醒发送失败");
      setToast(result.message || "飞书提醒已发送");
    } catch (reminderError) {
      setToast(reminderError instanceof Error ? reminderError.message : "提醒发送失败");
    }
  }

  const today = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date());

  if (!loading && authGate) {
    return <FeishuAccessGate key={authGate.kind} gate={authGate} onAuthenticated={async () => {
      if (mentorViewFromUrl() === "overview") await loadOverviewShell();
      else await loadDashboard();
    }} />;
  }

  const currentViewer = data?.viewer ?? viewer;

  if (loading && !currentViewer) {
    return <main className="student-portal-shell"><LoadingState /></main>;
  }

  if (!currentViewer && error) {
    return <main className="student-portal-shell"><div className="error-state"><strong>系统暂时无法加载</strong><span>{error}</span><button onClick={() => {
      if (mentorViewFromUrl() === "overview") void loadOverviewShell();
      else void loadDashboard();
    }}>重试</button></div></main>;
  }

  if (!currentViewer) return <main className="student-portal-shell"><LoadingState /></main>;

  if (data?.viewer.role === "student") {
    return <>
      <StudentPortal
        data={data}
        onRefresh={loadDashboard}
        onToast={setToast}
        onFeishu={() => setFeishuOpen(true)}
        onSwitchToManagement={() => void switchPersona("management")}
        personaBusy={personaBusy}
      />
      {feishuOpen ? <FeishuModal viewer={data.viewer} onClose={() => setFeishuOpen(false)} onSwitchPersona={switchPersona} personaBusy={personaBusy} onLogout={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </>;
  }

  const visibleNavItems = currentViewer.role === "superadmin"
    ? navItems
    : navItems.filter((item) => item.id !== "settings");
  const activeView: MentorView = currentViewer.role !== "superadmin" && view === "settings" ? "overview" : view;

  const viewerRoleLabel = currentViewer.role === "superadmin"
    ? "超级管理员"
    : currentViewer.role === "admin" ? "管理员（导师）" : "学生";
  const meetingPendingCount = meetingRequests.filter((request) => request.status === "requested").length;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">探</div>
          <div><strong>探研</strong><span>科研进展管理</span></div>
        </div>
        <nav aria-label="主导航">
          {visibleNavItems.map((item) => (
            <div className="nav-entry" key={item.id}>
              <button className={`nav-item ${activeView === item.id ? "active" : ""}`} onClick={() => navigateMentor(item.id)}>
                <span>{item.icon}</span>{item.label}
                {item.id === "inbox" && data && data.metrics.pending + data.metrics.proposalPending + data.metrics.guidancePending + (data.metrics.resolutionPending ?? 0) + data.metrics.blocked + meetingPendingCount > 0
                  ? <b>{data.metrics.pending + data.metrics.proposalPending + data.metrics.guidancePending + (data.metrics.resolutionPending ?? 0) + data.metrics.blocked + meetingPendingCount}</b> : null}
              </button>
            </div>
          ))}
        </nav>
        {currentViewer.canSwitchPersona ? <button className="persona-switch" type="button" disabled={personaBusy} onClick={() => void switchPersona("student")}><span aria-hidden="true">⇄</span><span><strong>{personaBusy ? "正在切换…" : "本人学生端"}</strong></span></button> : null}
        <button className="sidebar-foot" type="button" onClick={() => setFeishuOpen(true)} aria-label="查看飞书账号">
          <div className="avatar">{currentViewer.name.slice(0, 1) || "佘"}</div>
          <div><strong>{currentViewer.name || "佘阳"}</strong><span>{viewerRoleLabel}</span></div>
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar compact-topbar">
          <div className="workspace-heading">
            <h1>{navItems.find((item) => item.id === activeView)?.label}</h1>
            <p className="eyebrow">{today}</p>
          </div>
          <div className="workspace-tools">
            <label className="global-search">
              <span aria-hidden="true">⌕</span>
              <input
                ref={globalSearchRef}
                aria-label="全局搜索学生、阶段或研究方向"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (event.target.value && activeView !== "students" && activeView !== "overview") navigateMentor("students");
                }}
                placeholder="搜索学生或研究内容"
              />
              <kbd>⌘ K</kbd>
            </label>
            <button className="command-sync" type="button" onClick={() => {
              if (activeView === "overview") setOverviewRefreshRequest((current) => current + 1);
              else void loadDashboard();
            }} aria-label="同步最新数据" title="同步最新数据">↻</button>
            <button className="management-mobile-account" type="button" onClick={() => setFeishuOpen(true)}>账号</button>
            {data ? <button className="primary" onClick={() => setGuidanceOpen(true)}>＋ 记录指导</button> : null}
          </div>
        </header>

        {loading ? <LoadingState /> : null}
        {error ? <div className="error-state"><strong>数据暂时未加载</strong><span>{error}</span><button onClick={() => void loadDashboard()}>重试</button></div> : null}

        {!loading && !error && activeView === "overview" ? (
          <MentorGroupOverview query={query} onQueryChange={setQuery} refreshRequest={overviewRefreshRequest} />
        ) : null}

        {!loading && !error && data && activeView === "inbox" ? (
          <MentorDecisionInbox
            data={data}
            reviewBusy={reviewBusy}
            reviewNotes={reviewNotes}
            setReviewNotes={setReviewNotes}
            onReview={review}
            onToast={setToast}
            onRefresh={loadDashboard}
            meetingRequests={meetingRequests}
            meetingLoadError={meetingLoadError}
          />
        ) : null}

        {!loading && !error && data && activeView === "students" ? (
          <section className="panel roster-panel">
            <PanelHeader title="全部学生" subtitle="博士与硕士均已纳入首批试用" count={filteredStudents.length} />
            <StudentFilters query={query} setQuery={setQuery} riskFilter={riskFilter} setRiskFilter={setRiskFilter} degreeFilter={degreeFilter} setDegreeFilter={setDegreeFilter} />
            <StudentTable students={filteredStudents} />
          </section>
        ) : null}

        {!loading && !error && data && activeView === "research" ? (
          <MentorResearchLedger data={data} onToast={setToast} />
        ) : null}

        {!loading && !error && data && activeView === "meetings" ? <MeetingView viewer={data.viewer} students={data.students} meetingRequests={meetingRequests} meetingLoadError={meetingLoadError} onRemind={sendReminder} onToast={setToast} onMeetingChange={loadDashboard} /> : null}
        {!loading && !error && data && activeView === "cohort" ? <div className="cohort-workspace"><OverviewMetrics data={data} /><section className="panel roster-panel"><PanelHeader title="课题组培养节奏" subtitle="按距离上次实质性进展的时间排序" count={filteredStudents.length} /><StudentFilters query={query} setQuery={setQuery} riskFilter={riskFilter} setRiskFilter={setRiskFilter} degreeFilter={degreeFilter} setDegreeFilter={setDegreeFilter} /><StudentTable students={filteredStudents} /></section></div> : null}
        {!loading && !error && activeView === "settings" && data?.viewer.role === "superadmin" ? <SettingsView viewer={data.viewer} onFeishu={() => setFeishuOpen(true)} students={data.students} onRosterImported={async () => { setToast("真实学生名册已导入"); await loadDashboard(); }} /> : null}
      </section>

      {guidanceOpen && data ? <GuidanceQuickModal students={data.students} onClose={() => setGuidanceOpen(false)} onSaved={async () => { setGuidanceOpen(false); setToast("指导已保存，并进入学生下一步行动"); await loadDashboard(); }} /> : null}
      {feishuOpen ? <FeishuModal viewer={currentViewer} onClose={() => setFeishuOpen(false)} onSwitchPersona={switchPersona} personaBusy={personaBusy} onLogout={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}

type MentorTaskCategory = "decision" | "coordination" | "followup" | "waiting";
type MentorInboxTask =
  | { key: string; category: MentorTaskCategory; kind: "progress"; entry: PendingEntry }
  | { key: string; category: MentorTaskCategory; kind: "workflow"; task: DashboardData["workflowTasks"][number] }
  | { key: string; category: MentorTaskCategory; kind: "meeting"; request: MeetingRequest };

const mentorTaskLabels: Record<MentorTaskCategory, string> = {
  decision: "需要判断",
  coordination: "需要协调",
  followup: "需要跟进",
  waiting: "等待中",
};

function MentorDecisionInbox({ data, reviewBusy, reviewNotes, setReviewNotes, onReview, onToast, onRefresh, meetingRequests, meetingLoadError }: {
  data: DashboardData;
  reviewBusy: number | null;
  reviewNotes: Record<number, string>;
  setReviewNotes: Dispatch<SetStateAction<Record<number, string>>>;
  onReview: (entry: PendingEntry, action: string, guidance?: ReviewGuidance) => Promise<void>;
  onToast: (message: string) => void;
  onRefresh: () => Promise<void>;
  meetingRequests: MeetingRequest[];
  meetingLoadError: string;
}) {
  const [filter, setFilter] = useState<"all" | MentorTaskCategory>("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [meetingBusy, setMeetingBusy] = useState<number | null>(null);
  const [meetingNotes, setMeetingNotes] = useState<Record<number, string>>({});
  const [workflowBusy, setWorkflowBusy] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const tasks = useMemo<MentorInboxTask[]>(() => [
    ...data.pending.map((entry): MentorInboxTask => ({
      key: `progress-${entry.id}`,
      category: entry.can_finalize ? "decision" : "waiting",
      kind: "progress",
      entry,
    })),
    ...data.workflowTasks.map((task): MentorInboxTask => ({
      key: `workflow-${task.type}-${task.id}`,
      category: task.type === "proposal_review" || task.type === "guidance_verification" || task.type === "resolution_verification" ? "decision" : task.type === "blocked_milestone" ? "coordination" : "followup",
      kind: "workflow",
      task,
    })),
    ...meetingRequests.filter((request) => request.status === "requested").map((request): MentorInboxTask => ({
      key: `meeting-${request.id}`,
      category: "coordination",
      kind: "meeting",
      request,
    })),
  ], [data.pending, data.workflowTasks, meetingRequests]);
  const categoryPriority: Record<MentorTaskCategory, number> = { decision: 0, coordination: 1, followup: 2, waiting: 3 };
  const filtered = tasks
    .filter((task) => filter === "all" || task.category === filter)
    .sort((left, right) => categoryPriority[left.category] - categoryPriority[right.category]);
  const selected = filtered.find((task) => task.key === selectedKey) ?? filtered[0];

  async function handleMeeting(request: MeetingRequest, action: "confirm" | "decline") {
    const meetingNote = meetingNotes[request.id] || "";
    if (action === "decline" && !meetingNote.trim()) {
      onToast("拒绝预约前请填写具体原因");
      return;
    }
    setMeetingBusy(request.id);
    try {
      const response = await fetch("/api/meeting-requests", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: request.id,
          expectedVersion: request.version,
          action,
          responseNote: meetingNote,
        }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "预约处理失败");
      onToast(payload.message || "预约已处理");
      setMeetingNotes((current) => ({ ...current, [request.id]: "" }));
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "预约处理失败");
    } finally {
      setMeetingBusy(null);
    }
  }

  async function verifyGuidance(task: DashboardData["workflowTasks"][number]) {
    setWorkflowBusy(task.id);
    try {
      const response = await fetch("/api/student-guidance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id, action: "complete", expectedVersion: task.version }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "指导验收失败");
      onToast(payload.message || "已完成导师验收");
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "指导验收失败");
    } finally {
      setWorkflowBusy(null);
    }
  }

  const counts = tasks.reduce<Record<MentorTaskCategory, number>>((result, task) => {
    result[task.category] += 1;
    return result;
  }, { decision: 0, coordination: 0, followup: 0, waiting: 0 });

  return <section className="mentor-inbox">
    <div className="mentor-inbox-summary">
      <div><h2>{tasks.filter((task) => task.category !== "waiting").length} 项待处理</h2></div>
      <div className="mentor-inbox-filters" role="group" aria-label="待办类型">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 <b>{tasks.length}</b></button>
        {(Object.keys(mentorTaskLabels) as MentorTaskCategory[]).map((category) => <button className={filter === category ? "active" : ""} key={category} onClick={() => setFilter(category)}>{mentorTaskLabels[category]} <b>{counts[category]}</b></button>)}
      </div>
    </div>
    <div className="mentor-inbox-workspace">
      <div className="mentor-task-queue" aria-label="待办队列">
        {meetingLoadError ? <div className="mentor-task-load-error" role="alert"><strong>预约暂未同步</strong><small>{meetingLoadError}</small><button type="button" onClick={() => void onRefresh()}>重新读取</button></div> : null}
        {filtered.map((task) => {
          const student = task.kind === "progress" ? task.entry.display_name : task.kind === "workflow" ? task.task.studentName : task.request.student_name;
          const title = task.kind === "progress" ? task.entry.paper?.title || task.entry.title : task.kind === "workflow" ? task.task.title : task.request.topic;
          const meta = task.kind === "progress" ? `${isAiSummaryCandidate(task.entry) ? "AI 纪要候选" : task.entry.kind} · V${task.entry.current_revision}` : task.kind === "workflow" ? task.task.detail : `${task.request.preferred_date} ${task.request.preferred_time}`;
          return <button key={task.key} className={selected?.key === task.key ? "active" : ""} onClick={() => {
            setSelectedKey(task.key);
            if (window.matchMedia("(max-width: 780px)").matches) window.requestAnimationFrame(() => {
              detailRef.current?.scrollIntoView({ behavior: studentScrollBehavior(), block: "start" });
              detailRef.current?.focus({ preventScroll: true });
            });
          }}>
            <span className={`mentor-task-category ${task.category}`}>{mentorTaskLabels[task.category]}</span>
            <strong>{student}</strong><b>{title}</b><small>{meta}</small>
          </button>;
        })}
        {!filtered.length && !meetingLoadError ? <div className="mentor-task-empty"><span>✓</span><strong>这个队列已清空</strong><small>切换类型可查看其他事项。</small></div> : null}
      </div>
      <div className="mentor-task-detail" ref={detailRef} tabIndex={-1}>
        {selected?.kind === "progress" ? <MentorProgressDecision
          key={selected.entry.id}
          entry={selected.entry}
          busy={reviewBusy === selected.entry.id}
          note={reviewNotes[selected.entry.id] || ""}
          onNote={(value) => setReviewNotes((current) => ({ ...current, [selected.entry.id]: value }))}
          onReview={(action, guidance) => onReview(selected.entry, action, guidance)}
          onChanged={onRefresh}
        /> : null}
        {selected?.kind === "workflow" ? <article className="mentor-workflow-detail">
          <span className={`mentor-task-category ${selected.category}`}>{mentorTaskLabels[selected.category]}</span>
          <h2>{selected.task.title}</h2><p>{selected.task.studentName} · {selected.task.detail}</p>
          {selected.task.targetDate ? <div className="mentor-decision-fact"><span>目标日期</span><strong>{selected.task.targetDate}</strong></div> : null}
          {selected.task.type === "guidance_verification" && selected.task.context ? <div className="mentor-decision-fact"><span>原指导内容</span><strong>{selected.task.context}</strong></div> : null}
          {selected.task.type === "guidance_verification" && selected.task.nextAction ? <div className="mentor-decision-fact"><span>下一行动</span><strong>{selected.task.nextAction}</strong></div> : null}
          {selected.task.type === "guidance_verification" ? <div className="mentor-decision-fact"><span>验收标准</span><strong>{selected.task.acceptanceCriteria || "未设置；请进入指导记录补齐并核对"}</strong></div> : null}
          {selected.task.type === "resolution_verification" ? <ProgressResolutionPanel studentId={selected.task.studentId} entryId={selected.task.progressEntryId} mode="staff" onChanged={onRefresh} compact /> : null}
          {selected.task.type !== "resolution_verification" ? <><div className="mentor-decision-effect"><b>下一步</b><span>{selected.task.type === "proposal_review" ? "打开当前版本，确认、批注或退回修改。" : selected.task.type === "guidance_verification" ? "核对学生的完成说明与验收标准，再作出导师确认。" : selected.task.type === "blocked_milestone" ? "进入学生档案，明确阻塞需要的资源、判断或协作。" : "进入学生档案，重排期限或记录跟进指导。"}</span></div>
          <div className="mentor-detail-actions">{selected.task.type === "proposal_review" ? <a className="primary button-link" href={`/?mentorView=research&researchTab=proposals&proposal=${selected.task.id}`}>进入方案审核</a> : selected.task.type === "guidance_verification" ? <><a className={selected.task.acceptanceCriteria ? "button-link" : "primary button-link"} href={`/students/${encodeURIComponent(selected.task.studentId)}#guidance`}>查看指导记录</a>{selected.task.acceptanceCriteria ? <button className="primary" disabled={workflowBusy === selected.task.id} onClick={() => void verifyGuidance(selected.task)}>{workflowBusy === selected.task.id ? "验收中…" : "确认验收"}</button> : null}</> : <a className="primary button-link" href={`/students/${encodeURIComponent(selected.task.studentId)}#workflow`}>进入学生档案</a>}</div></> : null}
        </article> : null}
        {selected?.kind === "meeting" ? <article className="mentor-workflow-detail">
          <span className="mentor-task-category coordination">需要协调</span>
          <h2>{selected.request.topic}</h2><p>{selected.request.student_name} 申请 {selected.request.preferred_date} {selected.request.preferred_time}，预计 {selected.request.duration_minutes} 分钟。</p>
          {selected.request.note ? <div className="mentor-decision-fact"><span>学生备注</span><strong>{selected.request.note}</strong></div> : null}
          <label className="review-note-field">回复说明<textarea rows={3} value={meetingNotes[selected.request.id] || ""} onChange={(event) => setMeetingNotes((current) => ({ ...current, [selected.request.id]: event.target.value }))} placeholder="确认时可留空；拒绝时必须给出可行动的原因" /></label>
          <div className="mentor-detail-actions"><button disabled={meetingBusy === selected.request.id} onClick={() => void handleMeeting(selected.request, "decline")}>拒绝并说明</button><button className="primary" disabled={meetingBusy === selected.request.id} onClick={() => void handleMeeting(selected.request, "confirm")}>确认预约</button></div>
        </article> : null}
        {!selected ? <div className="mentor-task-detail-empty"><span>✓</span><h2>没有需要处理的事项</h2><p>新进展、方案、阻塞或预约到达后会进入这里。</p></div> : null}
      </div>
    </div>
  </section>;
}

function snapshotText(snapshot: Record<string, unknown> | undefined, key: string) {
  const value = snapshot?.[key];
  return typeof value === "string" ? value : "";
}

function isAiSummaryCandidate(entry: PendingEntry) {
  return entry.ai_summary_origin;
}

function MentorProgressDecision({ entry, busy, note, onNote, onReview, onChanged }: {
  entry: PendingEntry;
  busy: boolean;
  note: string;
  onNote: (value: string) => void;
  onReview: (action: string, guidance?: ReviewGuidance) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [nextAction, setNextAction] = useState(entry.paper?.next_action || entry.project?.next_action || "");
  const [dueDate, setDueDate] = useState(entry.paper?.next_action_due_date || entry.project?.next_action_due_date || "");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(entry.project?.evidence_target || "");
  const currentRevision = entry.revisions.find((revision) => revision.revision_number === entry.current_revision);
  const previousRevision = entry.revisions.find((revision) => revision.revision_number === entry.current_revision - 1);
  const previousSummary = snapshotText(previousRevision?.snapshot, "summary");
  const previousEvidence = snapshotText(previousRevision?.snapshot, "evidence");
  const aiCandidate = isAiSummaryCandidate(entry);
  async function submitGuidance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onReview("supplement", { nextAction, dueDate, acceptanceCriteria });
  }
  return <article className="mentor-progress-decision">
    <header><div><span>{aiCandidate ? "AI 纪要候选" : entry.kind} · 当前 V{entry.current_revision}</span><h2>{entry.paper?.title || entry.title}</h2><p>{entry.display_name} · {shortDate(entry.submitted_at)}提交</p></div><a href={`/students/${encodeURIComponent(entry.student_id)}#evidence`}>完整档案 ↗</a></header>
    {aiCandidate && entry.can_delete_ai ? <AiRecordActions record={entry} onChanged={onChanged} /> : null}
    {aiCandidate ? <div className="mentor-ai-candidate-note"><b>AI 已从组会纪要提取候选进展</b><span>以下内容尚未生效；只有您的勾选或退回指导会形成正式记录。</span></div> : null}
    <div className="mentor-decision-status"><span className={`status-pill ${entry.review_status === "in_review" ? "reviewing" : "pending"}`}>{entry.claim_stale ? "接手已超时" : entry.review_status === "in_review" ? `${entry.reviewer_name || "导师"}审核中` : "等待判断"}</span><small>正式判断将写入版本与审计记录</small></div>
    <section className="mentor-version-diff">
      <div><span>本版新增结论</span><p>{entry.summary || snapshotText(currentRevision?.snapshot, "summary") || "未填写"}</p></div>
      <div><span>本次提交的材料</span><p>{entry.evidence || snapshotText(currentRevision?.snapshot, "evidence") || "未填写"}</p></div>
      {previousRevision && previousSummary !== entry.summary ? <details><summary>查看与 V{previousRevision.revision_number} 的结论差异</summary><p>{previousSummary || "上一版未填写结论"}</p></details> : null}
      {previousRevision && previousEvidence !== entry.evidence ? <details><summary>查看上一版证据</summary><p>{previousEvidence || "上一版未填写证据"}</p></details> : null}
    </section>
    {entry.paper ? <div className="mentor-decision-facts"><div><span>论文阶段</span><strong>{paperStageMeta[entry.paper.stage].label}</strong></div><div><span>下一行动</span><strong>{entry.paper.next_action}</strong></div><div><span>期限</span><strong>{entry.paper.next_action_due_date}</strong></div>{activeBlockerText(entry.paper.blocker) ? <div className="blocker"><span>阻塞</span><strong>{entry.paper.blocker}</strong></div> : null}</div> : null}
    {entry.project ? <div className="mentor-decision-facts"><div><span>培养节点</span><strong>{entry.project.milestone_title || "未关联节点"}</strong></div><div><span>下一行动</span><strong>{entry.project.next_action}</strong></div><div><span>期限</span><strong>{entry.project.next_action_due_date}</strong></div>{activeBlockerText(entry.project.blocker) ? <div className="blocker"><span>阻塞</span><strong>{entry.project.blocker}</strong></div> : null}</div> : null}
    <div className="mentor-evidence-strip">{entry.evidence_sources.map((source) => <span key={source.id}><b>{source.label}</b>{source.source_ref ? <a href={source.source_ref} target="_blank" rel="noreferrer">打开证据</a> : null}{source.content_sha256 ? <small>指纹 {source.content_sha256}</small> : null}</span>)}{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><b>{attachment.file_name}</b><small>{fileSizeText(attachment.size_bytes)}</small></a>)}</div>
    {entry.can_decide ? <section className="mentor-binary-review" aria-label="快速判断">
      <div className="mentor-binary-review-head"><div><span>只做一个判断</span><strong>这可以作为学生的正式进展吗？</strong></div><small>确认后自动进入下一项</small></div>
      <div className="mentor-binary-actions" role="group" aria-label="确认或指导">
        <button type="button" className="confirm" disabled={busy} onClick={() => void onReview("substantive")}><span aria-hidden="true">✓</span><b>{busy ? "处理中…" : "确认进展"}</b><small>计入实质进展</small></button>
        <button type="button" className="guide" disabled={busy} aria-expanded={guidanceOpen} onClick={() => setGuidanceOpen((open) => !open)}><span aria-hidden="true">×</span><b>需要指导</b><small>退回并明确下一步</small></button>
      </div>
      {guidanceOpen ? <form className="mentor-inline-guidance" onSubmit={(event) => void submitGuidance(event)}>
        <header><div><span>退回指导</span><strong>一次写清问题、下一步和完成标准</strong></div><button type="button" onClick={() => setGuidanceOpen(false)} aria-label="收起指导表单">收起</button></header>
        <label className="wide">问题与指导<textarea rows={3} maxLength={3000} required value={note} onChange={(event) => onNote(event.target.value)} placeholder="例如：目前结论缺少对照实验，无法确认增益来自方法本身。" /></label>
        <label className="wide">学生下一步<textarea rows={2} maxLength={800} required value={nextAction} onChange={(event) => setNextAction(event.target.value)} placeholder="例如：补做无增强基线并更新结果表。" /></label>
        <label>建议期限<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
        <label>导师验收方式<input value="按完成标准确认" disabled /></label>
        <label className="wide">完成标准<textarea rows={2} maxLength={1200} required value={acceptanceCriteria} onChange={(event) => setAcceptanceCriteria(event.target.value)} placeholder="例如：提交包含同一数据划分、三次重复结果和误差条的对照表。" /></label>
        <footer><small>提交后，学生会在指导记录中看到下一步；完成后回到您的待办验收。</small><button type="submit" disabled={busy || !note.trim() || !nextAction.trim() || !acceptanceCriteria.trim()}>{busy ? "发送中…" : "退回并发送指导"}</button></footer>
      </form> : null}
    </section> : null}
    {!entry.can_decide && entry.claim_stale && entry.can_finalize ? <div className="mentor-reclaim-action"><p>上一位导师的接手已超时，领取后即可判断。</p><button className="primary" disabled={busy} onClick={() => void onReview("start_review")}>重新领取超时审核</button></div> : null}
    {!entry.can_finalize ? <div className="mentor-reclaim-action"><p>{entry.reviewer_name ? `等待 ${entry.reviewer_name} 完成判断` : "当前账号没有该学生的审核权限"}</p></div> : null}
    {entry.can_finalize ? <details className="mentor-advanced-review">
      <summary>其他判断与协作操作</summary>
      <p>仅留痕的支持性工作、明确判定为非进展，或需要先接手/释放审核时使用。</p>
      <label className="review-note-field">其他判断依据<textarea rows={3} value={note} onChange={(event) => onNote(event.target.value)} placeholder="判定为非进展时必须说明具体理由" /></label>
      <div className="review-actions">
        {entry.review_status === "submitted" ? <button disabled={busy} onClick={() => void onReview("start_review")}>接手审核</button> : null}
        {entry.can_release ? <button disabled={busy} onClick={() => void onReview("release_review")}>释放审核</button> : null}
        {entry.can_decide ? <><button disabled={busy} onClick={() => void onReview("supporting")}>仅记为支持性工作</button><button disabled={busy || !note.trim()} onClick={() => void onReview("rejected")}>判定为非进展</button></> : null}
      </div>
    </details> : null}
  </article>;
}

type MentorResearchTab = "papers" | "proposals" | "outputs";

function mentorResearchTabFromUrl(): MentorResearchTab {
  if (typeof window === "undefined") return "papers";
  const requested = new URL(window.location.href).searchParams.get("researchTab");
  return requested === "proposals" || requested === "outputs" ? requested : "papers";
}

function MentorResearchLedger({ data, onToast }: { data: DashboardData; onToast: (message: string) => void }) {
  const [tab, setTab] = useState<MentorResearchTab>(mentorResearchTabFromUrl);
  const initialProposalId = typeof window === "undefined" ? undefined : Number(new URL(window.location.href).searchParams.get("proposal")) || undefined;
  useEffect(() => {
    const restoreTab = () => setTab(mentorResearchTabFromUrl());
    window.addEventListener("popstate", restoreTab);
    return () => window.removeEventListener("popstate", restoreTab);
  }, []);
  function selectTab(next: MentorResearchTab) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("researchTab", next);
    if (next !== "proposals") url.searchParams.delete("proposal");
    window.history[tab === next ? "replaceState" : "pushState"]({}, "", url);
  }
  return <div className="mentor-research-ledger">
    <div className="research-ledger-tabs" role="tablist" aria-label="论文与课题分类"><button role="tab" aria-selected={tab === "papers"} className={tab === "papers" ? "active" : ""} onClick={() => selectTab("papers")}>论文 <b>{data.papers.length}</b></button><button role="tab" aria-selected={tab === "proposals"} className={tab === "proposals" ? "active" : ""} onClick={() => selectTab("proposals")}>课题方案 <b>{data.metrics.proposalPending} 待审</b></button><button role="tab" aria-selected={tab === "outputs"} className={tab === "outputs" ? "active" : ""} onClick={() => selectTab("outputs")}>成果 <b>{data.metrics.outputs}</b></button></div>
    {tab === "papers" ? <section className="panel research-paper-ledger"><PanelHeader title="论文" count={data.papers.length} /><div className="research-paper-list">{data.papers.map((paper) => <a key={paper.id} href={`/students/${encodeURIComponent(paper.student_id)}#papers`}><div><span>{paper.student_name} · {paper.paper_type}</span><strong>{paper.title}</strong><small>{paper.target_venue || "目标期刊/会议待定"}</small></div><div><b>{paperStageMeta[paper.current_stage].label}</b><em>{paper.planned_submission_date || "未设投稿日期"}</em><small>{paper.pending_count} 项待确认 · {paper.update_count} 次更新</small></div></a>)}{!data.papers.length ? <div className="empty-small">暂无论文。</div> : null}</div></section> : null}
    {tab === "proposals" ? <ProposalWorkspace viewer={data.viewer} students={data.students} onToast={onToast} initialSelectedId={initialProposalId} /> : null}
    {tab === "outputs" ? <section className="panel research-output-ledger"><PanelHeader title="科研成果" count={data.metrics.outputs} /><div>{data.students.filter((student) => student.outputCount > 0).sort((a, b) => b.outputCount - a.outputCount).map((student) => <a key={student.id} href={`/students/${encodeURIComponent(student.id)}#outputs`}><span><strong>{student.name}</strong><small>{student.stage} · {student.degree}</small></span><b>{student.outputCount} 项</b></a>)}{!data.metrics.outputs ? <div className="empty-small">尚无已登记成果。</div> : null}</div></section> : null}
  </div>;
}

function GuidanceQuickModal({ students, onClose, onSaved }: { students: Student[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verificationMode, setVerificationMode] = useState<"self_report" | "mentor_verify">("mentor_verify");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])") ?? []);
    focusable()[0]?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const response = await fetch("/api/student-guidance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "指导保存失败");
      await onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "指导保存失败");
      setBusy(false);
    }
  }

  return <div className="modal-layer" role="presentation"><div className="modal guidance-quick-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="guidance-quick-title"><button className="close" aria-label="关闭记录指导对话框" onClick={onClose}>×</button><div className="modal-title"><span>导师指导</span><h2 id="guidance-quick-title">把讨论变成一条可验收的下一步行动</h2><p>学生确认收到并提交完成说明；需要时由导师做最终验收。</p></div><form onSubmit={submit}>
    <div className="form-row"><label>学生<select name="studentId" required defaultValue=""><option value="" disabled>请选择学生</option>{students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.stage}</option>)}</select></label><label>指导类型<select name="guidanceType" defaultValue="general"><option value="general">一般指导</option><option value="meeting_followup">组会跟进</option><option value="paper">论文指导</option><option value="milestone">培养节点</option><option value="blocker">阻塞处理</option></select></label></div>
    <label>指导主题<input name="title" required placeholder="例如：补齐实验对照并形成可审阅图表" /></label>
    <label>指导内容<textarea name="content" rows={4} required placeholder="记录结论、关键取舍和学生需要理解的原因" /></label>
    <label>下一步行动<textarea name="nextAction" rows={2} required placeholder="例如：补做对照实验，更新结果图" /></label>
    <div className="form-row"><label>完成期限<input name="dueDate" type="date" required /></label><label>验收方式<select name="verificationMode" value={verificationMode} onChange={(event) => setVerificationMode(event.target.value as "self_report" | "mentor_verify")}><option value="mentor_verify">学生提交，导师验收</option><option value="self_report">学生自行完成</option></select></label></div>
    <label>验收标准<textarea name="acceptanceCriteria" rows={3} required={verificationMode === "mentor_verify"} placeholder={verificationMode === "mentor_verify" ? "例如：上传含三组对照的图表，误差条与参数说明完整" : "可选：写清学生自检条件"} /></label>
    {error ? <p className="form-error">{error}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存并交给学生"}</button></div>
  </form></div></div>;
}

const meetingStatusLabels: Record<MeetingRequest["status"], string> = {
  requested: "待处理",
  confirmed: "已确认",
  declined: "未通过",
  cancelled: "已取消",
};

const studentReviewLabels: Record<StudentProgress["review_status"], string> = {
  submitted: "已提交",
  in_review: "导师在看",
  accepted: "已确认",
  changes_requested: "需要补一下",
  rejected: "暂未通过",
};

type StudentView = "today" | "research" | "progress" | "library" | "mentor";
type StudentResearchTrack = "paper" | "project";
type StudentNavigationIntent = {
  view: StudentView;
  researchTrack?: StudentResearchTrack;
  entryId?: number;
  action?: "supplement";
  composerKind?: "论文" | "项目";
  focus?: "meeting" | "guidance";
  paperId?: number;
  milestoneId?: number;
  guidanceId?: number;
  meetingId?: number;
};

const studentViewMeta: Record<StudentView, { label: string; icon: string }> = {
  today: { label: "下一步", icon: "⌂" },
  research: { label: "研究", icon: "◇" },
  progress: { label: "进展", icon: "＋" },
  library: { label: "资料", icon: "▤" },
  mentor: { label: "导师", icon: "▣" },
};

function studentNavigationHref(intent: StudentNavigationIntent) {
  const params = new URLSearchParams();
  if (intent.view !== "today") params.set("studentView", intent.view);
  if (intent.view === "research") params.set("track", intent.researchTrack || "paper");
  if (intent.entryId) params.set("entry", String(intent.entryId));
  if (intent.action) params.set("action", intent.action);
  if (intent.composerKind) params.set("compose", intent.composerKind === "论文" ? "paper" : "project");
  if (intent.focus) params.set("focus", intent.focus);
  if (intent.paperId) params.set("paper", String(intent.paperId));
  if (intent.milestoneId) params.set("milestone", String(intent.milestoneId));
  if (intent.guidanceId) params.set("guidance", String(intent.guidanceId));
  if (intent.meetingId) params.set("meeting", String(intent.meetingId));
  return params.size ? `/?${params.toString()}` : "/";
}

function studentNavigationFromLocation(href: string): StudentNavigationIntent {
  const params = new URL(href).searchParams;
  const rawView = params.get("studentView");
  const view: StudentView = rawView === "research" || rawView === "progress" || rawView === "library" || rawView === "mentor" ? rawView : "today";
  const rawEntry = Number(params.get("entry"));
  const rawPaper = Number(params.get("paper"));
  const rawMilestone = Number(params.get("milestone"));
  const rawGuidance = Number(params.get("guidance"));
  const rawMeeting = Number(params.get("meeting"));
  const compose = params.get("compose");
  return {
    view,
    researchTrack: params.get("track") === "project" ? "project" : "paper",
    entryId: Number.isInteger(rawEntry) && rawEntry > 0 ? rawEntry : undefined,
    action: params.get("action") === "supplement" ? "supplement" : undefined,
    composerKind: compose === "paper" ? "论文" : compose === "project" ? "项目" : undefined,
    focus: params.get("focus") === "meeting" ? "meeting" : params.get("focus") === "guidance" ? "guidance" : undefined,
    paperId: Number.isInteger(rawPaper) && rawPaper > 0 ? rawPaper : undefined,
    milestoneId: Number.isInteger(rawMilestone) && rawMilestone > 0 ? rawMilestone : undefined,
    guidanceId: Number.isInteger(rawGuidance) && rawGuidance > 0 ? rawGuidance : undefined,
    meetingId: Number.isInteger(rawMeeting) && rawMeeting > 0 ? rawMeeting : undefined,
  };
}

function studentScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function studentNavigationTargetId(intent: StudentNavigationIntent) {
  if (intent.focus === "meeting" && intent.meetingId) return `student-meeting-${intent.meetingId}`;
  if (intent.focus === "meeting") return "student-meeting-form";
  if (intent.focus === "guidance" && intent.guidanceId) return `student-guidance-${intent.guidanceId}`;
  if (intent.focus === "guidance") return "student-guidance-inbox";
  if (intent.entryId) {
    return intent.action === "supplement" || intent.view === "research"
      ? `student-action-entry-${intent.entryId}`
      : `student-progress-${intent.entryId}`;
  }
  return intent.composerKind ? "student-quick-progress" : "student-view-main";
}

function studentNavigationFallbackTargetId(intent: StudentNavigationIntent) {
  if (intent.focus === "meeting") return "student-meeting-form";
  if (intent.focus === "guidance") return "student-guidance-inbox";
  return "student-view-main";
}

function StudentPortal({ data, onRefresh, onToast, onFeishu, onSwitchToManagement, personaBusy }: {
  data: DashboardData;
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
  onFeishu: () => void;
  onSwitchToManagement: () => void;
  personaBusy: boolean;
}) {
  const [view, setView] = useState<StudentView>("today");
  const [researchTrack, setResearchTrack] = useState<StudentResearchTrack>("paper");
  const [composer, setComposer] = useState<"论文" | "项目" | null>(null);
  const [composerVisible, setComposerVisible] = useState(false);
  const [composerTargetId, setComposerTargetId] = useState<number | null>(null);
  const [researchPaperId, setResearchPaperId] = useState<number | null>(null);
  const [resolutionRequest, setResolutionRequest] = useState<{ progressEntryId: number; itemKind: ProgressResolutionKind; key: number }>();
  const [pendingNavigation, setPendingNavigation] = useState<StudentNavigationIntent | null>(null);
  const student = data.students.find((item) => item.id === data.viewer.studentId);
  const papers = student ? data.papers.filter((paper) => paper.student_id === student.id) : [];
  const paperEntries = student?.progress.filter((entry) => entry.kind === "论文") ?? [];
  const projectEntries = student?.progress.filter((entry) => entry.kind === "项目") ?? [];
  const currentEntries = student ? student.progress.filter((entry) => currentStudentEntry(entry, student, papers)) : [];
  const paperReturned = currentEntries.filter((entry) => entry.kind === "论文" && entry.review_status === "changes_requested").length;
  const projectReturned = currentEntries.filter((entry) => entry.kind === "项目" && entry.review_status === "changes_requested").length;
  const waitingCount = currentEntries.filter((entry) => entry.review_status === "submitted" || entry.review_status === "in_review").length;

  const applyStudentNavigation = useCallback((intent: StudentNavigationIntent) => {
    const nextResearchTrack = intent.researchTrack || "paper";
    setView(intent.view);
    setResearchTrack(nextResearchTrack);
    setResearchPaperId(intent.view === "research" && nextResearchTrack === "paper" ? intent.paperId ?? null : null);
    if (intent.composerKind) setComposer(intent.composerKind);
    setComposerTargetId(intent.composerKind === "论文" ? intent.paperId ?? null
      : intent.composerKind === "项目" ? intent.milestoneId ?? null : null);
    setComposerVisible(Boolean(intent.composerKind));
    setPendingNavigation(intent);
  }, []);

  function navigateStudent(intent: StudentNavigationIntent) {
    const nextIntent = intent.view === "progress" && !intent.composerKind && composer && composerVisible ? { ...intent, composerKind: composer } : intent;
    window.history.pushState({ studentView: nextIntent.view }, "", studentNavigationHref(nextIntent));
    applyStudentNavigation(nextIntent);
  }

  useEffect(() => {
    function restoreStudentNavigation() {
      applyStudentNavigation(studentNavigationFromLocation(window.location.href));
    }
    restoreStudentNavigation();
    window.addEventListener("popstate", restoreStudentNavigation);
    return () => window.removeEventListener("popstate", restoreStudentNavigation);
  }, [applyStudentNavigation]);

  useEffect(() => {
    if (!pendingNavigation || pendingNavigation.view !== view) return;
    const intent = pendingNavigation;
    const targetId = studentNavigationTargetId(intent);
    const fallbackTargetId = studentNavigationFallbackTargetId(intent);
    const waitsForAsyncTarget = Boolean(
      (intent.focus === "guidance" && intent.guidanceId)
      || (intent.focus === "meeting" && intent.meetingId),
    );
    let frame = 0;
    let timeout = 0;
    let observer: MutationObserver | null = null;

    function focusNavigationTarget(allowFallback = false) {
      const target = document.getElementById(targetId)
        ?? (allowFallback ? document.getElementById(fallbackTargetId) : null);
      if (!target) return false;
      let ancestor = target.parentElement;
      while (ancestor) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      if (target instanceof HTMLDetailsElement) target.open = true;
      const supplement = intent.action === "supplement" ? target.querySelector("form")?.closest("details") : null;
      if (supplement instanceof HTMLDetailsElement) supplement.open = true;
      const focusTarget = supplement?.querySelector("summary") ?? target;
      target.scrollIntoView({ behavior: studentScrollBehavior(), block: target.id === "student-view-main" ? "start" : "center" });
      if (focusTarget instanceof HTMLElement) focusTarget.focus({ preventScroll: true });
      observer?.disconnect();
      if (timeout) window.clearTimeout(timeout);
      setPendingNavigation((current) => current === intent ? null : current);
      return true;
    }

    frame = window.requestAnimationFrame(() => {
      if (focusNavigationTarget()) return;
      if (!waitsForAsyncTarget) {
        focusNavigationTarget(true);
        return;
      }
      const root = document.getElementById("student-view-main");
      if (root) {
        observer = new MutationObserver(() => { focusNavigationTarget(); });
        observer.observe(root, { childList: true, subtree: true });
      }
      timeout = window.setTimeout(() => { focusNavigationTarget(true); }, 5_000);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timeout) window.clearTimeout(timeout);
      observer?.disconnect();
    };
  }, [pendingNavigation, view]);

  if (!student) return <main className="student-portal-shell"><div className="error-state"><strong>学生档案尚未绑定</strong><span>请联系管理员核对飞书账号与学生记录。</span></div></main>;

  function openComposer(kind: "论文" | "项目", targetId?: number) {
    navigateStudent({
      view: "progress",
      composerKind: kind,
      paperId: kind === "论文" ? targetId : undefined,
      milestoneId: kind === "项目" ? targetId : undefined,
    });
  }

  function openSupplement(entry: StudentProgress) {
    if (!student || !currentStudentEntry(entry, student, papers)) return;
    navigateStudent({ view: "progress", entryId: entry.id, action: "supplement" });
  }

  function openResearchSource(entry: StudentProgress) {
    if (entry.kind === "论文" || entry.kind === "项目") {
      navigateStudent({ view: "research", researchTrack: entry.kind === "项目" ? "project" : "paper", entryId: entry.id });
      return;
    }
    navigateStudent({ view: entry.kind === "组会" ? "mentor" : "progress", entryId: entry.id });
  }

  function openMeetingDesk(meetingId?: number) {
    navigateStudent({ view: "mentor", focus: "meeting", meetingId });
  }

  function openGuidanceDesk(guidanceId?: number) {
    navigateStudent({ view: "mentor", focus: "guidance", guidanceId });
  }
  return <div className="student-workbench-shell">
    <a className="student-skip-link" href="#student-view-main">跳到当前界面</a>
    <aside className="student-workbench-sidebar">
      <div className="brand"><div className="brand-mark">探</div><div><strong>探研</strong><span>学生端</span></div></div>
      <nav aria-label="我的科研导航">
        {(Object.entries(studentViewMeta) as Array<[StudentView, (typeof studentViewMeta)[StudentView]]>).map(([itemView, item]) => <a key={itemView} className={view === itemView ? "active" : ""} aria-current={view === itemView ? "page" : undefined} href={studentNavigationHref({ view: itemView })} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigateStudent({ view: itemView }); }}><i aria-hidden="true">{item.icon}</i><span>{item.label}</span></a>)}
      </nav>
      <button className="student-workbench-account" type="button" onClick={onFeishu}><span className="avatar">{data.viewer.name.slice(0, 1)}</span><span><strong>{data.viewer.name}</strong><small>飞书账号</small></span><i>›</i></button>
    </aside>

    <main className="student-portal-shell" id="student-view-main" tabIndex={-1} aria-labelledby={`student-view-${view}-title`}>
      <header className="student-portal-header">
        <div className="student-workbench-context"><strong>{student.currentFocus || "我的科研进展"}</strong></div>
        <div className="student-account">{data.viewer.canSwitchPersona ? <button className="student-persona-switch" type="button" disabled={personaBusy} onClick={onSwitchToManagement}>{personaBusy ? "正在切换…" : "返回管理端"}</button> : null}<button className="student-header-account" type="button" onClick={onFeishu}>账号</button></div>
      </header>

      {view === "today" ? <><StudentNextAction action={data.studentNextAction} student={student} papers={papers} onPaper={(paperId) => openComposer("论文", paperId)} onProject={(milestoneId) => openComposer("项目", milestoneId)} onMeeting={openMeetingDesk} onGuidance={openGuidanceDesk} onProgress={(entryId) => navigateStudent({ view: "progress", entryId })} onSupplement={openSupplement} onResolution={(progressEntryId, itemKind) => setResolutionRequest({ progressEntryId, itemKind, key: Date.now() })} /><ProgressResolutionPanel studentId={student.id} mode="student" onChanged={onRefresh} openRequest={resolutionRequest} compact /></> : null}

      {view === "research" ? <>
        <StudentViewIntro id="student-view-research-title" title="我的研究" metric={`${paperReturned + projectReturned}`} metricLabel="项待补充">
          <nav className="student-research-switch" aria-label="选择研究线">
            <a className={researchTrack === "paper" ? "active" : ""} aria-current={researchTrack === "paper" ? "page" : undefined} href={studentNavigationHref({ view: "research", researchTrack: "paper" })} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigateStudent({ view: "research", researchTrack: "paper" }); }}>论文研究<span>{papers.length} 篇</span></a>
            <a className={researchTrack === "project" ? "active" : ""} aria-current={researchTrack === "project" ? "page" : undefined} href={studentNavigationHref({ view: "research", researchTrack: "project" })} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigateStudent({ view: "research", researchTrack: "project" }); }}>课题研究<span>{projectEntries.length} 条</span></a>
          </nav>
        </StudentViewIntro>
        <StudentResearchTracks scope={researchTrack} student={student} papers={papers} selectedPaperId={researchPaperId} onSelectPaper={(paperId) => navigateStudent({ view: "research", researchTrack: "paper", paperId })} onOpenComposer={openComposer} />
      </> : null}

      {view === "progress" ? <StudentViewIntro id="student-view-progress-title" title="我的进展" metric={`${waitingCount}`} metricLabel="条等待导师">
        <div className="student-view-intro-actions"><button className="primary" type="button" onClick={() => openComposer("论文")}>记论文进展</button><button type="button" onClick={() => openComposer("项目")}>记课题进展</button></div>
      </StudentViewIntro> : null}
      {composer ? <div className="student-persistent-composer" hidden={view !== "progress" || !composerVisible}><StudentQuickProgressComposer key={`${composer}-${composerTargetId ?? "default"}`} kind={composer} initialTargetId={composerTargetId} student={student} papers={papers} onCancel={() => { setComposerVisible(false); setComposer(null); setComposerTargetId(null); window.history.replaceState({ studentView: "progress" }, "", studentNavigationHref({ view: "progress" })); }} onSaved={async () => { const savedKind = composer; setComposerVisible(false); setComposer(null); setComposerTargetId(null); window.history.replaceState({ studentView: "progress" }, "", studentNavigationHref({ view: "progress" })); onToast(`${savedKind === "论文" ? "论文" : "课题"}进展已提交，记录已更新`); await onRefresh(); }} /></div> : null}
      {view === "progress" ? <><StudentProgressOverview student={student} onChanged={onRefresh} onSupplement={openSupplement} currentEntryIds={new Set(currentEntries.map((entry) => entry.id))} />{paperReturned + projectReturned > 0 ? <details className="quiet-details student-supplement-section"><summary>待补充材料<span>{paperReturned + projectReturned} 条</span></summary><StudentProgressPanel student={student} papers={papers} onRefresh={onRefresh} onToast={onToast} returnedOnly /><StudentProjectProgressPanel student={student} onRefresh={onRefresh} onToast={onToast} returnedOnly /></details> : null}</> : null}

      {view === "library" ? <><StudentViewIntro id="student-view-library-title" title="我的资料" /><StudentResearchLibrary student={student} onOpenSource={openResearchSource} /></> : null}

      {view === "mentor" ? <><StudentViewIntro id="student-view-mentor-title" title="导师与组会" /><div className="student-mentor-grid"><StudentGuidanceInbox onToast={onToast} onRefresh={onRefresh} /><StudentMeetingRequests onToast={onToast} onRefresh={onRefresh} /><StudentProgressOverview student={student} fixedFilter="组会" /></div></> : null}

    </main>
  </div>;
}

function StudentViewIntro({ id, title, metric, metricLabel, children }: {
  id: string;
  title: string;
  metric?: string;
  metricLabel?: string;
  children?: ReactNode;
}) {
  return <section className="student-view-intro">
    <div><h1 id={id}>{title}</h1></div>
    {children}
    {metric && metric !== "0" ? <strong>{metric}<small>{metricLabel}</small></strong> : null}
  </section>;
}

function StudentNextAction({ action, student, papers, onPaper, onProject, onMeeting, onGuidance, onProgress, onSupplement, onResolution }: {
  action: DashboardData["studentNextAction"] | undefined;
  student: Student;
  papers: StudentPaper[];
  onPaper: (paperId?: number) => void;
  onProject: (milestoneId?: number) => void;
  onMeeting: (meetingId?: number) => void;
  onGuidance: (guidanceId?: number) => void;
  onProgress: (entryId?: number) => void;
  onSupplement: (entry: StudentProgress) => void;
  onResolution: (entryId: number, itemKind: ProgressResolutionKind) => void;
}) {
  const focus = action?.primary ?? {
    id: "onboarding",
    kind: "onboarding" as const,
    destination: papers.some((paper) => paper.status === "active") ? "paper" as const : "project" as const,
    kicker: "从第一条记录开始",
    title: student.currentFocus || "记录最近完成的工作",
    detail: `建议每 ${student.cadenceDays} 天至少更新一次。`,
    meta: "完成后记录论文或课题进展",
    attention: false,
    waiting: false,
  };
  const actionLabel = focus.destination === "resolution"
    ? focus.waiting ? "查看处理结果" : focus.itemKind === "blocker" ? "提交处理结果" : "提交完成结果"
    : focus.destination === "supplement"
    ? "补充材料"
    : focus.destination === "meeting"
      ? focus.kind === "waiting" ? "查看会议预约" : "约导师解决阻塞"
      : focus.destination === "guidance"
        ? "查看导师指导"
      : focus.destination === "paper"
        ? "记录论文进展"
        : focus.destination === "progress"
          ? "查看已提交进展"
          : "记录课题进展";

  function runAction() {
    if (focus.destination === "resolution" && focus.targetId && focus.itemKind) {
      onResolution(focus.targetId, focus.itemKind);
      return;
    }
    if (focus.destination === "supplement") {
      const returnedEntry = student.progress.find((entry) => entry.id === focus.targetId);
      if (returnedEntry) onSupplement(returnedEntry);
      return;
    }
    if (focus.destination === "meeting") {
      onMeeting(focus.kind === "waiting" ? focus.targetId : undefined);
      return;
    }
    if (focus.destination === "guidance") {
      onGuidance(focus.targetId);
      return;
    }
    if (focus.destination === "progress") {
      onProgress(focus.targetId);
      return;
    }
    if (focus.destination === "paper") {
      onPaper(focus.targetId);
      return;
    }
    onProject(focus.targetId);
  }

  return <section className="student-next-action-page" aria-labelledby="student-view-today-title">
    <header><h1 id="student-view-today-title">下一步行动</h1></header>
    <article className={`student-next-action-card ${focus.attention ? "attention" : ""}`}>
      <span>{focus.kicker}</span>
      <strong>{focus.title}</strong>
      <p>{focus.detail}</p>
      <small>{focus.meta}</small>
      {action?.additionalActionCount ? <small className="student-next-action-more">另有 {action.additionalActionCount} 项待办</small> : null}
      {action?.waitingCount && focus.kind !== "waiting" ? <small className="student-next-action-waiting">另有 {action.waitingCount} 项已提交，正在等待导师</small> : null}
      <button className="primary" type="button" onClick={runAction}>{actionLabel}</button>
    </article>
  </section>;
}

function formDataHasVerifiableEvidence(formData: FormData) {
  const evidence = String(formData.get("evidence") ?? "").trim();
  const gitUrl = String(formData.get("gitUrl") ?? "").trim();
  const hasAttachment = formData.getAll("attachments").some((item) => item instanceof File && item.size > 0);
  return Boolean(evidence || gitUrl || hasAttachment);
}

function StudentQuickProgressComposer({ kind, initialTargetId, student, papers, onCancel, onSaved }: {
  kind: "论文" | "项目";
  initialTargetId: number | null;
  student: Student;
  papers: StudentPaper[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const activePapers = papers.filter((paper) => paper.status === "active" || paper.status === "on_hold");
  const activeMilestones = [...student.milestones]
    .filter((milestone) => milestone.status !== "completed")
    .sort((a, b) => a.sort_order - b.sort_order);
  const initialPaper = activePapers.find((paper) => paper.id === initialTargetId) ?? activePapers[0];
  const [paperSelection, setPaperSelection] = useState(initialPaper ? String(initialPaper.id) : "new");
  const selectedPaper = activePapers.find((paper) => String(paper.id) === paperSelection);
  const [paperStage, setPaperStage] = useState<PaperStage>(selectedPaper?.current_stage ?? "planning");
  const initialMilestone = activeMilestones.find((milestone) => milestone.id === initialTargetId) ?? activeMilestones[0];
  const [projectMilestoneSelection, setProjectMilestoneSelection] = useState(initialMilestone ? String(initialMilestone.id) : "");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [{ minimumDate, nextWeek }] = useState(() => {
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
    const today = new Date();
    const due = new Date(today);
    due.setDate(due.getDate() + 7);
    return { minimumDate: formatter.format(today), nextWeek: formatter.format(due) };
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const summary = String(formData.get("summary") ?? "").trim();
    if (!summary) return setFormError("写一句这次做完了什么");
    if (!formDataHasVerifiableEvidence(formData)) return setFormError("请填写材料说明、提供 GitHub 链接，或上传附件");
    const firstLine = summary.split(/\n/u)[0].slice(0, 70);
    formData.set("studentId", student.id);
    formData.set("kind", kind);
    formData.set("title", (kind === "论文" ? `${selectedPaper?.title || String(formData.get("paperTitle") || "论文")} · ${firstLine}` : firstLine).slice(0, 160));
    formData.set("literatureRef", "");
    if (kind === "论文") {
      formData.set("paperStage", paperStage);
      if (selectedPaper) {
        formData.set("paperId", String(selectedPaper.id));
        formData.set("targetVenue", "");
        formData.set("plannedSubmissionDate", "");
      }
    }
    setBusy(true); setFormError("");
    try {
      const response = await fetch("/api/progress", { method: "POST", headers: { "Idempotency-Key": mutationKeyForForm(form) }, body: formData });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "提交失败，请再试一次");
      clearMutationKey(form);
      await onSaved();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "提交失败，请再试一次");
    } finally {
      setBusy(false);
    }
  }

  return <section className="student-quick-progress" id="student-quick-progress" tabIndex={-1} aria-labelledby="student-quick-progress-title">
    <header><h2 id="student-quick-progress-title">{kind === "论文" ? "记录论文进展" : "记录课题进展"}</h2><button type="button" onClick={onCancel}>收起</button></header>
    <form onSubmit={submit} onInvalidCapture={(event) => {
      const details = (event.target as HTMLElement).closest("details");
      if (details) details.open = true;
    }}>
      {kind === "论文" ? <>
        <div className="student-quick-row"><label>哪篇论文<select value={paperSelection} onChange={(event) => { const value = event.target.value; setPaperSelection(value); setPaperStage(activePapers.find((paper) => String(paper.id) === value)?.current_stage ?? "planning"); }}>{activePapers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}<option value="new">新建一篇论文</option></select></label><label>现在写到哪一步<select value={paperStage} onChange={(event) => setPaperStage(event.target.value as PaperStage)}>{paperStages.map((stage) => <option key={stage} value={stage}>{paperStageMeta[stage].label}</option>)}</select></label></div>
        {!selectedPaper ? <div className="student-quick-row new-paper"><label>论文题目<input name="paperTitle" required placeholder="暂定题目也可以" /></label><label>类型<select name="paperType" defaultValue="期刊论文">{paperTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>计划投稿<input name="plannedSubmissionDate" type="date" min={minimumDate} required /></label></div> : null}
        <label className="wide">这次做完了什么<textarea name="summary" rows={4} required placeholder="例如：补完了实验部分，图 3 和图 4 已经换成新结果。" /></label>
        <label className="wide">稿件版本<input name="manuscriptVersion" required placeholder="例如：v0.4、R1、commit 8f3a2c" /></label>
        <div className="student-quick-row"><label>下一步<input name="nextAction" required placeholder="例如：把讨论部分改完" /></label><label>准备什么时候完成<input name="nextActionDueDate" type="date" min={minimumDate} defaultValue={nextWeek} required /></label></div>
      </> : <>
        <div className="student-quick-project-plan">
          <div><span>当前研究方案</span><strong>{student.proposalTitle || "尚无已确认研究方案"}</strong><small>{student.proposalVersion ? `方案 V${student.proposalVersion}` : "可先记录进展，方案确认后再关联节点"}</small></div>
          <label>关联培养节点<select name="linkedMilestoneId" value={projectMilestoneSelection} onChange={(event) => setProjectMilestoneSelection(event.target.value)} required={activeMilestones.length > 0} disabled={!activeMilestones.length}><option value="">{activeMilestones.length ? "请选择" : "暂无可关联节点"}</option>{activeMilestones.map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title} · {milestoneStatusLabels[milestone.status]}</option>)}</select></label>
          {!activeMilestones.length ? <input type="hidden" name="linkedMilestoneId" value="" /> : null}
        </div>
        <label className="wide">这次做完了什么<textarea name="summary" rows={4} required placeholder="例如：完成第一轮测试，结果表和异常样本已整理。" /></label>
        <div className="student-quick-row"><label>下一行动<input name="nextAction" required placeholder="例如：补做低温组对照实验" /></label><label>计划完成日期<input name="nextActionDueDate" type="date" min={minimumDate} defaultValue={nextWeek} required /></label></div>
        <label htmlFor="student-project-completion-request" className={`student-completion-request ${projectMilestoneSelection ? "" : "disabled"}`}><input id="student-project-completion-request" name="completionRequested" type="checkbox" value="1" disabled={!projectMilestoneSelection} /><span>申请完成所选节点<small>申请不会直接改状态；导师确认为实质性进展后才完成。</small></span></label>
      </>}
      <label className="wide student-evidence-field">材料说明<textarea name="evidence" rows={3} placeholder={kind === "论文" ? "例如：稿件第 4–6 页、图 3/4，或评审记录位置。如果上传了附件可不填。" : "例如：实验批次 EXP-024、结果表 Sheet-2、验收记录位置。如果上传了附件可不填。"} /><small>填写证据位置、链接或编号，也可直接上传文件。</small></label>
      <details className="quiet-details student-optional-fields">
        <summary>补充信息<span>阻塞、Git 链接{kind === "论文" ? "、稿件编号" : ""}</span></summary>
        <div>
          <label className="wide">当前阻塞（可选）<textarea name="blocker" rows={2} placeholder="需要导师决策、数据或资源时填写。" /></label>
          <label className="wide">私有 GitHub 链接（可选）<input name="gitUrl" type="url" placeholder="https://github.com/…" /></label>
          {kind === "论文" ? <label className="wide">稿件编号 / DOI（可选）<input name="submissionIdentifier" placeholder="投稿后填写稿件号或 DOI" /></label> : null}
        </div>
      </details>
      <label className="student-quick-file">附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件，单个不超过 50 MB，总计不超过 80 MB</small></label>
      {formError ? <p className="form-error" role="alert">{formError}</p> : null}
      <footer><button type="button" onClick={onCancel}>取消</button><button className="primary" disabled={busy}>{busy ? "正在提交…" : "提交"}</button></footer>
    </form>
  </section>;
}

function StudentResearchTracks({ scope, student, papers, selectedPaperId, onSelectPaper, onOpenComposer }: {
  scope: StudentResearchTrack;
  student: Student;
  papers: StudentPaper[];
  selectedPaperId: number | null;
  onSelectPaper: (paperId: number) => void;
  onOpenComposer: (kind: "论文" | "项目", targetId?: number) => void;
}) {
  const entries = [...student.progress].sort((a, b) => progressRevisionTime(b) - progressRevisionTime(a) || b.id - a.id);
  const trackingPapers = papers.filter((paper) => paper.status === "active" || paper.status === "on_hold");
  const defaultPaper = trackingPapers.find((paper) => paper.status === "active") ?? trackingPapers[0] ?? papers[0];
  const leadPaper = trackingPapers.find((paper) => paper.id === selectedPaperId) ?? defaultPaper;
  const paperEntries = entries.filter((entry) => entry.kind === "论文");
  const projectEntries = entries.filter((entry) => entry.kind === "项目");
  const selectedPaperEntries = leadPaper ? paperEntries.filter((entry) => entry.paper?.id === leadPaper.id) : [];
  const latestPaperEntry = selectedPaperEntries.find((entry) => entry.review_status !== "rejected");
  const latestProjectEntry = projectEntries[0];
  const planMilestones = student.proposalStatus === "approved" ? [...student.milestones].sort((a, b) => a.sort_order - b.sort_order) : [];
  const linkedMilestone = planMilestones.find((milestone) => milestone.id === latestProjectEntry?.project?.milestone_id);
  const currentLinkedMilestone = latestProjectEntry?.project?.proposal_version === student.proposalVersion && linkedMilestone?.status !== "completed" ? linkedMilestone : undefined;
  const currentProjectMilestoneId = currentLinkedMilestone?.id
    ?? planMilestones.find((milestone) => milestone.status === "in_progress")?.id
    ?? planMilestones.find((milestone) => milestone.status === "pending" || milestone.status === "blocked")?.id;
  const scopedEntries = scope === "paper" ? paperEntries : projectEntries;
  const latestEntry = scopedEntries[0];
  const pendingCount = scopedEntries.filter((entry) => currentStudentEntry(entry, student, papers) && (entry.review_status === "submitted" || entry.review_status === "in_review")).length;
  const repliedCount = scopedEntries.filter((entry) => Boolean(entry.reviewer_note?.trim())).length;
  const stageIndex = leadPaper ? paperStages.indexOf(leadPaper.current_stage) : -1;
  const stagePercent = stageIndex < 0 ? 0 : Math.round((stageIndex / (paperStages.length - 1)) * 100);
  const paperActionCurrent = leadPaper?.status === "active" && latestPaperEntry?.review_status === "accepted";
  const nextAction = leadPaper?.status === "on_hold" ? "论文已暂停"
    : leadPaper && ["accepted", "published", "closed"].includes(leadPaper.status) ? "论文已完成当前跟踪"
      : latestPaperEntry && ["submitted", "in_review"].includes(latestPaperEntry.review_status) ? "已提交进展，等待导师确认"
        : latestPaperEntry?.review_status === "changes_requested" ? "按导师意见补充进展"
          : latestPaperEntry?.follow_up_states?.next_action === "resolved" ? "上一项计划已完成，继续记录新的进展"
            : latestPaperEntry?.follow_up_states?.next_action === "pending" ? "完成结果已提交，等待管理员确认"
          : paperActionCurrent ? latestPaperEntry?.paper?.next_action || "下一步待填写" : "先记录这篇论文的下一行动";
  const nextActionDate = paperActionCurrent && !["resolved", "pending"].includes(latestPaperEntry?.follow_up_states?.next_action ?? "") ? latestPaperEntry?.paper?.next_action_due_date || null : null;
  const actionDeadline = paperDeadlineState(nextActionDate || null);
  const updateDays = daysSinceLatestSubmission(student);
  const rhythmOverdue = Boolean(entries.length) && updateDays > student.cadenceDays;
  const rhythmLabel = !entries.length ? "还没有记录" : updateDays === 0 ? "今天已更新" : rhythmOverdue ? `超过计划 ${updateDays - student.cadenceDays} 天` : `${updateDays} 天前更新`;

  return <section className="student-research-tracks" id="student-research-tracks" aria-labelledby="student-research-tracks-title">
    <h2 className="visually-hidden" id="student-research-tracks-title">{scope === "paper" ? "论文进展" : "课题进展"}</h2>

    <div className="student-research-track-grid single">
      {scope === "paper" ? <article className="student-research-track paper-track">
        {trackingPapers.length > 1 ? <div className="student-paper-selector" role="group" aria-label="选择要查看的论文">
          {trackingPapers.map((paper) => {
            const paperUpdates = paperEntries.filter((entry) => entry.paper?.id === paper.id).length;
            const selected = paper.id === leadPaper?.id;
            return <button key={paper.id} type="button" className={selected ? "active" : ""} aria-pressed={selected} onClick={() => onSelectPaper(paper.id)}><span>{paper.status === "on_hold" ? "已暂停" : "推进中"}</span><strong>{paper.title}</strong><small>{paperUpdates} 次更新 · {paperStageMeta[paper.current_stage].label}</small></button>;
          })}
        </div> : null}
        <div className="student-research-track-head"><span className="student-research-track-icon">文</span><div><strong>{leadPaper?.title || "还没有建立论文"}</strong></div><em>{selectedPaperEntries.length} 次更新</em></div>
        {leadPaper ? <>
          <div className="student-paper-stage-summary"><span>当前阶段</span><strong>{paperStageMeta[leadPaper.current_stage].label}</strong><em>第 {stageIndex + 1} / {paperStages.length} 阶段</em></div>
          <div className="student-paper-stage-bar" role="progressbar" aria-label={`${leadPaper.title} 论文阶段位置`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={stagePercent}><i style={{ width: `${stagePercent}%` }} /></div>
          <details className="quiet-details student-stage-details"><summary>查看全部阶段</summary><ol className="student-paper-stage-steps">{paperStages.map((stage, index) => <li key={stage} aria-current={index === stageIndex ? "step" : undefined} className={index < stageIndex ? "done" : index === stageIndex ? "current" : ""}><i /><small>{paperStageMeta[stage].label}</small></li>)}</ol></details>
          <p className="student-paper-stage-gate">这一阶段要做到：{paperStageMeta[leadPaper.current_stage].gate}</p>
          <div className={`student-track-next-action ${actionDeadline.overdue ? "overdue" : ""}`}><span>{paperActionCurrent ? "当前安排" : "当前状态"}</span><strong>{nextAction}</strong><small>{nextActionDate ? `准备完成：${nextActionDate} · ${actionDeadline.label}` : "完成后记一条论文进展"}</small></div>
        </> : <div className="student-track-empty"><strong>先把论文建起来</strong><span>题目可以先写暂定名，后面随时继续更新。</span></div>}
        <button type="button" onClick={() => onOpenComposer("论文", leadPaper?.id)}>{leadPaper ? "记录这篇论文的进展" : "新建论文并记录"}</button>
      </article> : null}

      {scope === "project" ? <article className="student-research-track project-track">
        <div className="student-research-track-head"><span className="student-research-track-icon">题</span><div><strong>{student.proposalTitle || "尚无已确认研究方案"}</strong></div><em>{student.proposalVersion ? `方案 V${student.proposalVersion}` : "待确认"}</em></div>
        {planMilestones.length ? <section className="student-project-plan" aria-label="已确认研究方案与培养节点">
          <header><div><span>执行路线</span><strong>{planMilestones.filter((milestone) => milestone.status === "completed").length}/{planMilestones.length} 个节点已完成</strong></div><small>节点由导师确认，进展记录只能发起完成申请。</small></header>
          <ol>{planMilestones.map((milestone, index) => <li key={milestone.id} className={`${milestone.status} ${milestone.id === currentProjectMilestoneId ? "current" : ""}`}>
            <i>{milestone.status === "completed" ? "✓" : index + 1}</i>
            <div><strong>{milestone.title}</strong><small>{milestone.target_date ? `目标日期 ${milestone.target_date}` : "未设置目标日期"}</small><p>{milestone.evidence_target || "尚未填写验收证据"}</p></div>
            <em>{milestoneStatusLabels[milestone.status]}</em>
          </li>)}</ol>
        </section> : <div className="student-project-plan-empty"><strong>研究方案还没有形成可执行节点</strong><span>方案确认后，这里会显示每个节点的日期、验收证据和执行状态。</span></div>}
        {latestProjectEntry ? <div className="student-project-latest"><time>{shortDate(latestProjectEntry.submitted_at)} · V{latestProjectEntry.current_revision}</time><h3>{latestProjectEntry.title}</h3><p>{latestProjectEntry.summary || latestProjectEntry.evidence}</p>{latestProjectEntry.project ? <div><span>本次记录的后续计划</span><strong>{latestProjectEntry.project.next_action}</strong><small>{latestProjectEntry.project.next_action_due_date ? `计划 ${latestProjectEntry.project.next_action_due_date}` : "未设置期限"}</small></div> : null}{latestProjectEntry.attachments.length ? <small>{latestProjectEntry.attachments.length} 个附件已保存</small> : <small>这次没有附件</small>}</div> : <div className="student-track-empty"><strong>先记下最近做完的事</strong><span>实验、测试、数据整理和阶段结果都可以写。</span></div>}
        {latestProjectEntry?.project ? <div className="student-project-next"><span>关联节点</span><strong>{latestProjectEntry.project.milestone_title || "未关联节点"}</strong><small>{linkedMilestone?.status === "completed" ? "该节点已完成" : latestProjectEntry.project.milestone_id && !currentLinkedMilestone ? "该记录属于历史方案或节点" : latestProjectEntry.project.completion_requested && latestProjectEntry.review_status !== "accepted" ? "已申请完成，等待导师确认" : latestProjectEntry.project.evidence_target || "继续围绕节点积累证据"}</small></div> : student.nextMilestone ? <div className="student-project-next"><span>下一培养节点</span><strong>{student.nextMilestone}</strong><small>{student.nextMilestoneDate ? `目标 ${student.nextMilestoneDate}` : "围绕节点形成一项可核验成果"}</small></div> : null}
        <div className={`student-project-rhythm ${rhythmOverdue ? "overdue" : ""}`}><span>记录节奏</span><strong>{rhythmLabel}</strong><small>建议每 {student.cadenceDays} 天至少更新一次</small></div>
        <div className="student-project-review"><span>最近状态</span><strong>{latestProjectEntry ? studentReviewLabels[latestProjectEntry.review_status] : "等待第一条记录"}</strong></div>
        <button type="button" onClick={() => onOpenComposer("项目", currentProjectMilestoneId)}>记录课题进展</button>
      </article> : null}
    </div>

    <footer className="student-research-track-facts"><span><b>{scopedEntries.length}</b> 次{scope === "paper" ? "论文" : "课题"}更新</span><span><b>{pendingCount}</b> 条等导师回复</span><span><b>{repliedCount}</b> 条已有导师意见</span><span><b>{latestEntry ? shortDate(latestEntry.submitted_at) : "—"}</b> 最近记录</span></footer>
  </section>;
}

type StudentLibraryMode = "files" | "sources";
type StudentLibraryKind = "all" | "论文" | "项目" | "组会";
type StudentLibraryReview = "all" | "waiting" | "accepted" | "attention";
type StudentLibrarySort = "recent" | "name" | "size";

const studentLibraryKinds: Array<{ value: StudentLibraryKind; label: string }> = [
  { value: "all", label: "全部" },
  { value: "论文", label: "论文" },
  { value: "项目", label: "课题" },
  { value: "组会", label: "AI 组会" },
];

function studentLibraryReviewMatches(status: StudentProgress["review_status"], filter: StudentLibraryReview) {
  if (filter === "all") return true;
  if (filter === "waiting") return status === "submitted" || status === "in_review";
  if (filter === "accepted") return status === "accepted";
  return status === "changes_requested" || status === "rejected";
}

function studentEvidenceHref(source: StudentProgress["evidence_sources"][number]) {
  if ((source.source_type === "git" || source.source_type === "url") && source.source_ref.startsWith("https://")) return source.source_ref;
  if (source.source_type === "doi" && /^10\.\d{4,9}\//u.test(source.source_ref)) return `https://doi.org/${source.source_ref}`;
  return "";
}

function StudentResearchLibrary({ student, onOpenSource }: { student: Student; onOpenSource: (entry: StudentProgress) => void }) {
  const [mode, setMode] = useState<StudentLibraryMode>("files");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<StudentLibraryKind>("all");
  const [reviewFilter, setReviewFilter] = useState<StudentLibraryReview>("all");
  const [sort, setSort] = useState<StudentLibrarySort>("recent");
  const files = useMemo(() => student.progress.flatMap((entry) => entry.attachments.map((attachment) => ({ entry, attachment }))), [student.progress]);
  const sources = useMemo(() => student.progress.flatMap((entry) => entry.evidence_sources
    .filter((source) => source.source_type !== "attachment")
    .map((source) => ({ entry, source }))), [student.progress]);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const fileMatches = files.filter(({ entry, attachment }) => {
    const matchesQuery = !normalizedQuery || [attachment.file_name, entry.title, entry.summary, entry.paper?.title, entry.paper?.manuscript_version]
      .some((value) => value?.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
    return matchesQuery && (kindFilter === "all" || entry.kind === kindFilter) && studentLibraryReviewMatches(entry.review_status, reviewFilter);
  });
  const sourceMatches = sources.filter(({ entry, source }) => {
    const matchesQuery = !normalizedQuery || [source.label, source.source_ref, entry.title, entry.summary, entry.paper?.title]
      .some((value) => value?.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
    return matchesQuery && (kindFilter === "all" || entry.kind === kindFilter) && studentLibraryReviewMatches(entry.review_status, reviewFilter);
  });
  const visibleFiles = [...fileMatches].sort((a, b) => sort === "name"
    ? a.attachment.file_name.localeCompare(b.attachment.file_name, "zh-CN")
    : sort === "size"
      ? b.attachment.size_bytes - a.attachment.size_bytes
      : new Date(b.entry.submitted_at).getTime() - new Date(a.entry.submitted_at).getTime());
  const visibleSources = [...sourceMatches].sort((a, b) => sort === "name"
    ? a.source.label.localeCompare(b.source.label, "zh-CN")
    : new Date(b.entry.submitted_at).getTime() - new Date(a.entry.submitted_at).getTime());
  const acceptedFiles = files.filter(({ entry }) => entry.review_status === "accepted").length;
  const totalBytes = files.reduce((sum, { attachment }) => sum + attachment.size_bytes, 0);
  const visibleCount = mode === "files" ? visibleFiles.length : visibleSources.length;

  return <section className="student-research-library" id="student-research-library" aria-labelledby="student-research-library-title">
    <header>
      <div><span>ARTIFACTS &amp; SOURCES</span><h2 id="student-research-library-title">我的科研资料库</h2><p>跨论文和课题查找资料，并追溯到提交、审核与校验指纹。</p></div>
      <div className="student-research-library-summary"><strong>{files.length}</strong><small>个文件 · {files.length ? fileSizeText(totalBytes) : "0 KB"}</small><em>{acceptedFiles} 个已确认</em></div>
    </header>
    <nav className="student-research-library-tabs" aria-label="科研资料类型">
      <button type="button" className={mode === "files" ? "active" : ""} aria-pressed={mode === "files"} onClick={() => setMode("files")}><span>研究文件</span><b>{files.length}</b></button>
      <button type="button" className={mode === "sources" ? "active" : ""} aria-pressed={mode === "sources"} onClick={() => { setMode("sources"); if (sort === "size") setSort("recent"); }}><span>证据来源</span><b>{sources.length}</b></button>
    </nav>
    <div className="student-research-library-toolbar">
      <label className="student-research-library-search"><span>搜索资料</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="文件名、论文、进展或来源" /></label>
      <label><span>审核状态</span><select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as StudentLibraryReview)}><option value="all">全部状态</option><option value="waiting">等待导师</option><option value="accepted">已确认</option><option value="attention">需处理</option></select></label>
      <label><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value as StudentLibrarySort)}><option value="recent">最近提交</option><option value="name">名称</option>{mode === "files" ? <option value="size">文件大小</option> : null}</select></label>
    </div>
    <div className="student-research-library-filters">
      {studentLibraryKinds.map((option) => { const count = mode === "files" ? files.filter(({ entry }) => option.value === "all" || entry.kind === option.value).length : sources.filter(({ entry }) => option.value === "all" || entry.kind === option.value).length; return <button type="button" key={option.value} className={kindFilter === option.value ? "active" : ""} aria-pressed={kindFilter === option.value} onClick={() => setKindFilter(option.value)}><span>{option.label}</span><b>{count}</b></button>; })}
      <small aria-live="polite">当前显示 {visibleCount} 项</small>
    </div>

    {mode === "files" ? <div className="student-research-library-list">
      {visibleFiles.map(({ entry, attachment }) => { const extension = attachment.file_name.split(".").pop()?.slice(0, 5).toUpperCase() || "FILE"; return <article className={`kind-${studentProgressKindMeta(entry.kind).className}`} key={attachment.id}>
        <span className="student-research-file-type" aria-hidden="true">{extension}</span>
        <div className="student-research-file-main"><span><strong>{attachment.file_name}</strong><em className={`student-state ${entry.review_status}`}>{studentReviewLabels[entry.review_status]}</em></span><small>{studentProgressKindMeta(entry.kind).label} · {entry.paper?.title || entry.title}</small><p>{entry.paper?.manuscript_version ? `${entry.paper.manuscript_version} · ` : ""}{shortDate(entry.submitted_at)} · {fileSizeText(attachment.size_bytes)}</p></div>
        <details className="student-research-provenance">
          <summary>来源与校验<i aria-hidden="true" /></summary>
          <div><dl><div><dt>所属进展</dt><dd>{entry.title}</dd></div><div><dt>内容指纹</dt><dd>{attachment.content_sha256 ? `${attachment.content_sha256}…` : "未记录"}</dd></div><div><dt>审核事件</dt><dd>{entry.audit.length} 条</dd></div><div><dt>导师回复</dt><dd>{entry.reviewer_note || "暂无"}</dd></div></dl><footer><button type="button" onClick={() => onOpenSource(entry)}>打开来源记录</button><a href={attachment.download_url} download>下载原文件</a></footer></div>
        </details>
      </article>; })}
      {!visibleFiles.length ? <div className="student-portal-empty">{files.length ? "没有找到匹配的科研文件。" : "提交进展时上传附件后，文件会自动汇总到这里。"}</div> : null}
    </div> : <div className="student-research-library-list source-list">
      {visibleSources.map(({ entry, source }) => { const externalHref = studentEvidenceHref(source); return <article className={`kind-${studentProgressKindMeta(entry.kind).className}`} key={`${entry.id}-${source.id}`}>
        <span className="student-research-file-type source" aria-hidden="true">源</span>
        <div className="student-research-file-main"><span><strong>{source.label}</strong><em>{studentProgressKindMeta(entry.kind).label}</em></span><small>{entry.paper?.title || entry.title}</small><p>{source.source_ref || "已保存来源快照"} · {shortDate(entry.submitted_at)}</p></div>
        <div className="student-research-source-actions"><button type="button" onClick={() => onOpenSource(entry)}>来源记录</button>{externalHref ? <a href={externalHref} target="_blank" rel="noreferrer">打开来源</a> : null}<small>指纹 {source.content_sha256 ? `${source.content_sha256}…` : "未记录"}</small></div>
      </article>; })}
      {!visibleSources.length ? <div className="student-portal-empty">{sources.length ? "没有找到匹配的证据来源。" : "进展中的文字证据、DOI、Git 链接和组会来源会汇总到这里。"}</div> : null}
    </div>}
  </section>;
}

type StudentProgressFilter = "all" | "论文" | "项目" | "组会";

const studentProgressFilters: Array<{ value: StudentProgressFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "论文", label: "论文" },
  { value: "项目", label: "课题" },
  { value: "组会", label: "AI 组会" },
];

function studentProgressKindMeta(kind: string) {
  if (kind === "论文") return { label: "论文", icon: "文", className: "paper" };
  if (kind === "项目") return { label: "课题", icon: "题", className: "project" };
  if (kind === "组会") return { label: "AI 组会", icon: "会", className: "meeting" };
  return { label: kind || "进展", icon: "记", className: "other" };
}

function revisionSnapshotText(snapshot: Record<string, unknown>, key: string) {
  const containers = [snapshot, snapshot.entry, snapshot.progress, snapshot.values]
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  for (const container of containers) {
    const value = container[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function StudentProjectDetail({ project }: { project: StudentProjectProgress }) {
  return <dl className="student-progress-entry-project">
    <div><dt>关联节点</dt><dd>{project.milestone_title || "未关联节点"}</dd><small>{project.milestone_target_date ? `目标 ${project.milestone_target_date}` : "未设置节点日期"}</small></div>
    <div><dt>下一行动</dt><dd>{project.next_action}</dd><small>{project.next_action_due_date ? `计划 ${project.next_action_due_date}` : "未设置期限"}</small></div>
    {project.evidence_target ? <div className="wide"><dt>节点验收证据</dt><dd>{project.evidence_target}</dd></div> : null}
    {activeBlockerText(project.blocker) ? <div className="wide blocker"><dt>本次记录的困难</dt><dd>{project.blocker}</dd></div> : null}
    {project.completion_requested ? <div className="wide completion"><dt>节点完成申请</dt><dd>已申请；只有导师确认为实质性进展后才回写完成。</dd></div> : null}
  </dl>;
}

function StudentRevisionHistory({ entry }: { entry: StudentProgress }) {
  const revisions = [...entry.revisions].sort((a, b) => b.revision_number - a.revision_number);
  if (!revisions.length) return null;
  return <details className="student-revision-history">
    <summary><span>版本历史</span><b>{revisions.length} 个不可变更版本</b><small>当前 V{entry.current_revision}</small></summary>
    <ol>{revisions.map((revision) => {
      const summary = revisionSnapshotText(revision.snapshot, "summary") || (revision.revision_number === entry.current_revision ? entry.summary : "");
      const evidence = revisionSnapshotText(revision.snapshot, "evidence") || (revision.revision_number === entry.current_revision ? entry.evidence : "");
      const attachments = entry.attachments.filter((attachment) => (attachment.revision_number || 1) === revision.revision_number);
      const sources = entry.evidence_sources.filter((source) => (source.revision_number || 1) === revision.revision_number);
      return <li key={revision.id} className={revision.revision_number === entry.current_revision ? "current" : ""}>
        <header><span>V{revision.revision_number}</span><time>{shortDate(revision.created_at)}</time><em className={`student-state ${revision.review_status}`}>{studentReviewLabels[revision.review_status]}</em></header>
        {summary ? <p>{summary}</p> : <p className="muted">该历史版本已封存。</p>}
        {evidence ? <small>证据：{evidence}</small> : null}
        {attachments.length || sources.length ? <footer><span>{attachments.length} 个附件</span><span>{sources.length} 条证据来源</span></footer> : null}
        {revision.reviewer_note ? <blockquote><b>{revision.reviewer_name || "导师"}的当版意见</b><span>{revision.reviewer_note}</span></blockquote> : null}
      </li>;
    })}</ol>
  </details>;
}

function StudentProgressOverview({ student, fixedFilter, onSupplement, currentEntryIds, onChanged }: { student: Student; fixedFilter?: Exclude<StudentProgressFilter, "all">; onSupplement?: (entry: StudentProgress) => void; currentEntryIds?: Set<number>; onChanged?: () => Promise<void> }) {
  const [openedEntries, setOpenedEntries] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<StudentProgressFilter>("all");
  const entries = useMemo(() => [...student.progress].sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime()), [student.progress]);
  const activeFilter = fixedFilter || filter;
  const visibleEntries = activeFilter === "all" ? entries : entries.filter((entry) => entry.kind === activeFilter);

  return <section className="student-progress-overview" id="student-progress-overview" aria-labelledby="student-progress-overview-title">
    <header className="student-progress-overview-head">
      <h2 id="student-progress-overview-title">{fixedFilter === "组会" ? "AI 组会记录" : "进展记录"}</h2>
      <strong>{visibleEntries.length}<small>条记录</small></strong>
    </header>

    {!fixedFilter ? <nav className="student-progress-filters" aria-label="筛选我的进展">
      {studentProgressFilters.map((option) => { const count = option.value === "all" ? entries.length : entries.filter((entry) => entry.kind === option.value).length; return <button key={option.value} type="button" className={filter === option.value ? "active" : ""} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}><span>{option.label}</span><b>{count}</b></button>; })}
    </nav> : null}

    <div className="student-progress-overview-list">
      {visibleEntries.map((entry) => { const kind = studentProgressKindMeta(entry.kind); const context = entry.reviewer_note ? `导师已回复：${entry.reviewer_note}` : entry.kind === "组会" ? entry.evidence_sources[0]?.label || "飞书会议纪要" : entry.paper ? `${paperStageMeta[entry.paper.stage].label} · ${entry.paper.manuscript_version}` : entry.project ? `${entry.project.milestone_title || "未关联节点"} · V${entry.current_revision}` : "点开查看完整内容"; return <details id={`student-progress-${entry.id}`} key={`${activeFilter}-${entry.id}`} className={`student-progress-entry kind-${kind.className}`} onToggle={(event) => { const isOpen = event.currentTarget.open; setOpenedEntries((current) => { const next = new Set(current); if (isOpen) next.add(entry.id); else next.delete(entry.id); return next; }); }}>
        <summary>
          <span className="student-progress-entry-icon" aria-hidden="true">{kind.icon}</span>
          <span className="student-progress-entry-date"><time>{shortDate(entry.submitted_at)}</time><small>{kind.label}</small></span>
          <span className="student-progress-entry-title"><strong>{entry.paper?.title || entry.title}</strong><small>{context}</small></span>
          <em className={`student-state ${entry.review_status}`}>{studentReviewLabels[entry.review_status]}</em><i aria-hidden="true">查看</i>
        </summary>
        <article>
          {entry.review_status === "changes_requested" && onSupplement && currentEntryIds?.has(entry.id) ? <>
            <blockquote><b>{entry.reviewer_name ? `${entry.reviewer_name}的回复` : "导师回复"}</b><span>{entry.reviewer_note || "请按要求补充内容、证据或附件。"}</span></blockquote>
            <button className="primary student-progress-supplement" type="button" onClick={() => onSupplement(entry)}>补充材料</button>
          </> : <>
            <p>{entry.summary || entry.evidence}</p>
            {entry.paper ? <dl className="student-progress-entry-paper"><div><dt>论文阶段</dt><dd>{paperStageMeta[entry.paper.stage].label}</dd></div><div><dt>下一步</dt><dd>{entry.paper.next_action}</dd></div><div><dt>准备完成</dt><dd>{entry.paper.next_action_due_date}</dd></div></dl> : null}
            {entry.project ? <StudentProjectDetail project={entry.project} /> : null}
            {entry.evidence ? <div className="student-progress-evidence"><span>材料说明</span><p>{entry.evidence}</p></div> : null}
            {entry.attachments?.length ? <div className="student-attachment-list" aria-label="提交附件">{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><span>↧</span><b>{attachment.file_name}</b><small>V{attachment.revision_number || 1} · {fileSizeText(attachment.size_bytes)}</small></a>)}</div> : null}
            {entry.reviewer_note ? <blockquote><b>{entry.reviewer_name ? `${entry.reviewer_name}的回复` : "导师回复"}</b><span>{entry.reviewer_note}</span></blockquote> : null}
            {openedEntries.has(entry.id) && (entry.paper || entry.project) ? <ProgressResolutionPanel studentId={student.id} mode="student" entryId={entry.id} onChanged={onChanged} compact /> : null}
            <StudentRevisionHistory entry={entry} />
          </>}
        </article>
      </details>; })}
      {!visibleEntries.length ? <div className="student-portal-empty">这个分类还没有记录。提交后会直接出现在这里。</div> : null}
    </div>
  </section>;
}

function StudentProgressPanel({ student, papers, onRefresh, onToast, returnedOnly = false }: {
  student: Student;
  papers: StudentPaper[];
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
  returnedOnly?: boolean;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const entries = [...student.progress]
    .filter((entry) => entry.kind === "论文" && (!returnedOnly || (entry.review_status === "changes_requested" && currentStudentEntry(entry, student, papers))))
    .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());

  async function resubmit(event: FormEvent<HTMLFormElement>, entry: StudentProgress) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    if (!formDataHasVerifiableEvidence(formData)) {
      onToast("请填写材料说明、提供 GitHub 链接，或上传附件");
      return;
    }
    formData.set("id", String(entry.id));
    formData.set("expectedRevision", String(entry.current_revision));
    formData.set("title", entry.title);
    setBusy(entry.id);
    try {
      const response = await fetch("/api/progress", {
        method: "PATCH",
        body: formData,
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "补充证据提交失败");
      onToast(payload.message || "补充证据已重新提交");
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "补充证据提交失败");
    } finally { setBusy(null); }
  }

  if (returnedOnly && !entries.length) return null;
  return <section className={`student-portal-panel student-progress-feed${returnedOnly ? " returned-only" : ""}`}>
    <div className="student-portal-panel-head"><div><span>{returnedOnly ? "需要补充" : "我的论文"}</span><h2>{returnedOnly ? "论文补证" : "论文进展"}</h2><p>{returnedOnly ? "在这里修改退回内容；重新提交会生成新版本。" : "最近写了什么、导师怎么回复，都按时间放在这里。"}</p></div><b>{entries.length}</b></div>
    {!returnedOnly ? <div className="student-paper-register">{papers.map((paper) => { const due = paperDeadlineState(paper.planned_submission_date); const deadlineLabel = paper.status === "published" ? "已发表" : paper.status === "accepted" ? "已录用" : due.label; return <article key={paper.id}>
      <div><span className={`paper-stage stage-${paper.current_stage}`}>{paperStageMeta[paper.current_stage].label}</span><em className={paper.status === "active" && due.overdue ? "overdue" : ""}>{deadlineLabel}</em></div>
      <h3>{paper.title}</h3><p>{paper.paper_type}{paper.target_venue ? ` · ${paper.target_venue}` : " · 目标期刊/会议待定"}</p>
      <footer><span>{paper.update_count} 次更新</span><span>{paper.pending_count ? `${paper.pending_count} 条待反馈` : "无待反馈"}</span></footer>
    </article>; })}{!papers.length ? <div className="student-portal-empty">还没有论文。点上方“记论文进展”，可以直接新建。</div> : null}</div> : null}
    <div className="student-progress-feed-list">{entries.map((entry) => <article id={`student-action-entry-${entry.id}`} tabIndex={-1} key={entry.id}>
      <div><span className={`student-state ${entry.review_status}`}>{studentReviewLabels[entry.review_status]}</span><time>{shortDate(entry.submitted_at)}</time></div>
      <h3>{entry.paper?.title || entry.title}</h3><small>{entry.paper ? `${paperStageMeta[entry.paper.stage].label} · ${entry.paper.manuscript_version} · V${entry.current_revision}` : `历史论文进展 · V${entry.current_revision}`}</small><p>{entry.summary}</p>
      {entry.paper ? <dl className="student-paper-update-detail"><div><dt>接下来做</dt><dd>{entry.paper.next_action}</dd></div><div><dt>准备完成</dt><dd>{entry.paper.next_action_due_date}</dd></div>{entry.paper.submission_identifier ? <div><dt>稿件编号 / DOI</dt><dd>{entry.paper.submission_identifier}</dd></div> : null}{activeBlockerText(entry.paper.blocker) ? <div className="blocker"><dt>卡在哪里</dt><dd>{entry.paper.blocker}</dd></div> : null}</dl> : null}
      {entry.evidence ? <div className="student-progress-evidence"><span>材料说明</span><p>{entry.evidence}</p></div> : null}
      {entry.attachments?.length ? <div className="student-attachment-list" aria-label="提交附件">{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><span>↧</span><b>{attachment.file_name}</b><small>V{attachment.revision_number || 1} · {fileSizeText(attachment.size_bytes)}</small></a>)}</div> : null}
      {entry.reviewer_note ? <blockquote><b>导师回复</b><span>{entry.reviewer_note}</span></blockquote> : null}
      <StudentRevisionHistory entry={entry} />
      {entry.review_status === "changes_requested" && currentStudentEntry(entry, student, papers) ? <details><summary>按导师意见补一下</summary><form onSubmit={(event) => void resubmit(event, entry)}>
        <label>改完后的内容<textarea name="summary" rows={3} required defaultValue={entry.summary} /></label>
        <label>材料说明<textarea name="evidence" rows={3} defaultValue={entry.evidence} placeholder="也可改为提供 GitHub 链接或附件" /></label>
        {entry.kind === "文献" ? <label>论文题目 / DOI<input name="literatureRef" required defaultValue={entry.literature_ref} /></label> : <input type="hidden" name="literatureRef" value={entry.literature_ref || ""} />}
        {entry.paper ? <>{entry.paper.id ? <input type="hidden" name="paperId" value={entry.paper.id} /> : <><input type="hidden" name="paperTitle" value={entry.paper.title} /><input type="hidden" name="paperType" value={entry.paper.paper_type} /><input type="hidden" name="targetVenue" value={entry.paper.target_venue} /><input type="hidden" name="plannedSubmissionDate" value={entry.paper.planned_submission_date || ""} /></>}<label>论文阶段<select name="paperStage" defaultValue={entry.paper.stage}>{paperStages.map((stage) => <option key={stage} value={stage}>{paperStageMeta[stage].label}</option>)}</select></label><label>稿件版本<input name="manuscriptVersion" required defaultValue={entry.paper.manuscript_version} /></label><label>下一行动<textarea name="nextAction" rows={2} required defaultValue={entry.paper.next_action} /></label><label>行动期限<input name="nextActionDueDate" type="date" required defaultValue={entry.paper.next_action_due_date} /></label><label>阻塞问题（可选）<textarea name="blocker" rows={2} defaultValue={entry.paper.blocker} /></label><label>稿件编号 / DOI（可选）<input name="submissionIdentifier" defaultValue={entry.paper.submission_identifier} /></label></> : null}
        <label>私有 GitHub 链接（可选）<input name="gitUrl" type="url" defaultValue={entry.git_url || ""} placeholder="https://github.com/…" /></label>
        <label>补充附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件，单个不超过 50 MB，总计不超过 80 MB</small></label>
        <button className="primary" disabled={busy === entry.id}>{busy === entry.id ? "提交中…" : "重新提交"}</button>
      </form></details> : null}
    </article>)}{!entries.length ? <div className="student-portal-empty">还没有论文进展。提交后会直接显示在这里。</div> : null}</div>
  </section>;
}

function StudentProjectProgressPanel({ student, onRefresh, onToast, returnedOnly = false }: {
  student: Student;
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
  returnedOnly?: boolean;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const entries = [...student.progress]
    .filter((entry) => entry.kind === "项目" && (!returnedOnly || (entry.review_status === "changes_requested" && currentStudentEntry(entry, student))))
    .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());

  async function resubmit(event: FormEvent<HTMLFormElement>, entry: StudentProgress) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    if (!formDataHasVerifiableEvidence(formData)) {
      onToast("请填写材料说明、提供 GitHub 链接，或上传附件");
      return;
    }
    formData.set("id", String(entry.id));
    formData.set("expectedRevision", String(entry.current_revision));
    formData.set("title", entry.title);
    setBusy(entry.id);
    try {
      const response = await fetch("/api/progress", { method: "PATCH", body: formData });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "课题内容提交失败");
      onToast(payload.message || "课题内容已重新提交");
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "课题内容提交失败");
    } finally { setBusy(null); }
  }

  if (returnedOnly && !entries.length) return null;
  return <section className={`student-portal-panel student-project-feed${returnedOnly ? " returned-only" : ""}`}>
    <div className="student-portal-panel-head"><div><span>{returnedOnly ? "需要补充" : "我的课题"}</span><h2>{returnedOnly ? "课题补证" : "课题进展"}</h2><p>{returnedOnly ? "在这里修改退回内容；重新提交会生成新版本。" : "平时做完的实验、数据和阶段结果都记在这里。"}</p></div><b>{entries.length}</b></div>
    <div className="student-progress-feed-list">{entries.map((entry) => <article id={`student-action-entry-${entry.id}`} tabIndex={-1} key={entry.id}>
      <div><span className={`student-state ${entry.review_status}`}>{studentReviewLabels[entry.review_status]}</span><time>{shortDate(entry.submitted_at)}</time></div>
      <h3>{entry.title}</h3><small>{entry.project?.milestone_title ? `${entry.project.milestone_title} · V${entry.current_revision}` : `课题进展 · V${entry.current_revision}`}</small><p>{entry.summary}</p>
      {entry.project ? <StudentProjectDetail project={entry.project} /> : null}
      {entry.evidence ? <div className="student-progress-evidence"><span>材料说明</span><p>{entry.evidence}</p></div> : null}
      {entry.attachments?.length ? <div className="student-attachment-list" aria-label="课题附件">{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><span>↧</span><b>{attachment.file_name}</b><small>V{attachment.revision_number || 1} · {fileSizeText(attachment.size_bytes)}</small></a>)}</div> : null}
      {entry.reviewer_note ? <blockquote><b>导师回复</b><span>{entry.reviewer_note}</span></blockquote> : null}
      <StudentRevisionHistory entry={entry} />
      {entry.review_status === "changes_requested" && currentStudentEntry(entry, student) ? <details><summary>按导师意见补一下</summary><form onSubmit={(event) => void resubmit(event, entry)}>
        <label>改完后的内容<textarea name="summary" rows={3} required defaultValue={entry.summary} /></label>
        <label>材料说明<textarea name="evidence" rows={3} defaultValue={entry.evidence} placeholder="也可改为提供 GitHub 链接或附件" /></label>
        <label>关联培养节点<select name="linkedMilestoneId" defaultValue={entry.project?.milestone_id && student.milestones.some((milestone) => milestone.id === entry.project?.milestone_id && milestone.status !== "completed") ? String(entry.project.milestone_id) : ""}><option value="">暂不关联节点</option>{student.milestones.filter((milestone) => milestone.status !== "completed").sort((a, b) => a.sort_order - b.sort_order).map((milestone) => <option key={milestone.id} value={milestone.id}>{milestone.title} · {milestoneStatusLabels[milestone.status]}</option>)}</select></label>
        <label>下一行动<textarea name="nextAction" rows={2} required defaultValue={entry.project?.next_action || ""} /></label>
        <label>计划完成日期<input name="nextActionDueDate" type="date" required defaultValue={entry.project?.next_action_due_date || ""} /></label>
        <label>当前阻塞（可选）<textarea name="blocker" rows={2} defaultValue={entry.project?.blocker || ""} /></label>
        <input type="hidden" name="completionRequested" value="0" />
        <label htmlFor={`student-project-completion-${entry.id}`} className="student-completion-request"><input id={`student-project-completion-${entry.id}`} name="completionRequested" type="checkbox" value="1" defaultChecked={entry.project?.completion_requested} /><span>申请完成所选节点<small>导师确认实质性进展后才会回写完成。</small></span></label>
        <input type="hidden" name="literatureRef" value="" /><label>私有 GitHub 链接（可选）<input name="gitUrl" type="url" defaultValue={entry.git_url} placeholder="仅支持 https://" /></label>
        <label>补充附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件，单个不超过 50 MB，总计不超过 80 MB</small></label>
        <button className="primary" disabled={busy === entry.id}>{busy === entry.id ? "提交中…" : "重新提交"}</button>
      </form></details> : null}
    </article>)}{!entries.length ? <div className="student-portal-empty">还没有课题进展。点上方“记课题进展”就能添加。</div> : null}</div>
  </section>;
}

function guidanceDueLabel(note: StudentGuidanceNote) {
  if (note.status === "completed") return "已完成";
  if (note.student_reported_at && note.verification_mode === "mentor_verify") return "待导师验收";
  if (!note.due_date) return "未设置期限";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${note.due_date}T00:00:00+08:00`);
  const days = Math.ceil((due.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天后到期`;
}

function StudentGuidanceInbox({ compact = false, onToast, onRefresh }: {
  compact?: boolean;
  onToast: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [notes, setNotes] = useState<StudentGuidanceNote[]>([]);
  const [completionNotes, setCompletionNotes] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/student-guidance", { cache: "no-store" });
      const payload = await response.json() as { notes?: StudentGuidanceNote[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "导师指导读取失败");
      setNotes(payload.notes ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: Error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function update(note: StudentGuidanceNote, action: "acknowledge" | "complete") {
    setBusy(note.id);
    setMessage("");
    try {
      const response = await fetch("/api/student-guidance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: note.id,
          action,
          expectedVersion: note.version,
          completionNote: action === "complete" ? completionNotes[note.id] || "" : "",
        }),
      });
      const payload = await response.json() as { message?: string; error?: string };
      if (!response.ok) {
        if (response.status === 409) await Promise.all([load(), onRefresh()]);
        throw new Error(payload.error || "导师指导更新失败");
      }
      setCompletionNotes((current) => ({ ...current, [note.id]: "" }));
      onToast(payload.message || (action === "complete" ? "指导事项已完成" : "已确认收到"));
      await Promise.all([load(), onRefresh()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导师指导更新失败");
    } finally {
      setBusy(null);
    }
  }

  const openNotes = notes.filter((note) => note.status === "open");
  const visibleNotes = compact ? openNotes.slice(0, 3) : notes;
  if (compact && !loading && !openNotes.length && !message) return null;

  return <section className={`student-portal-panel student-guidance-inbox${compact ? " compact" : ""}`} id={compact ? undefined : "student-guidance-inbox"} tabIndex={compact ? undefined : -1}>
    <div className="student-portal-panel-head"><div><span>导师指导</span><h2>{compact ? "导师给你的下一步" : "收到的导师指导"}</h2><p>{compact ? "先确认收到，再完成导师布置的具体行动。" : "指导内容、行动期限和完成回报都保留在同一条记录中。"}</p></div><strong>{openNotes.length}<small>项进行中</small></strong></div>
    {loading ? <div className="student-portal-empty">正在读取导师指导…</div> : <div className="student-guidance-inbox-list">
      {visibleNotes.map((note) => <article key={note.id} id={`student-guidance-${note.id}`} tabIndex={-1} className={note.status}>
        <header><div><span>{note.mentor_name} · {shortDate(note.created_at)}</span><strong>{note.title || "导师指导"}</strong></div><em>{guidanceDueLabel(note)}</em></header>
        <p>{note.content}</p>
        {note.next_action ? <div className="student-guidance-next"><span>下一步</span><strong>{note.next_action}</strong>{note.due_date ? <small>期限 {note.due_date}</small> : null}{note.acceptance_criteria ? <div className="student-guidance-criteria"><span>完成标准</span><p>{note.acceptance_criteria}</p></div> : null}</div> : null}
        {note.events?.length ? <details className="student-guidance-history"><summary>查看状态与完成说明历史（{note.events.length}）</summary><ol>{note.events.map((event) => <li key={event.id}><span>{event.actor_name || (event.actor_type === "student" ? "学生" : event.actor_type === "staff" ? "导师" : "系统")} · {shortDate(event.created_at)}</span><strong>{event.action === "created" ? "创建指导" : event.action === "acknowledged" ? "确认收到" : event.action === "completed" ? "提交/确认完成" : "重新打开"}</strong>{event.note ? <p>{event.note}</p> : null}</li>)}</ol></details> : null}
        {note.status === "open" ? <footer>
          {!note.acknowledged_at ? <button type="button" disabled={busy === note.id} onClick={() => void update(note, "acknowledge")}>确认收到</button> : <span className="student-guidance-ack">✓ 已确认收到</span>}
          {note.student_reported_at && note.verification_mode === "mentor_verify" ? <span className="student-guidance-awaiting">✓ 已提交完成说明，等待导师验收{note.completion_note ? `：${note.completion_note}` : ""}</span> : null}
          <label>完成说明{note.verification_mode === "mentor_verify" ? "（必填）" : "（可选）"}<input value={completionNotes[note.id] || ""} maxLength={1000} onChange={(event) => setCompletionNotes((current) => ({ ...current, [note.id]: event.target.value }))} placeholder="例如：已补做实验并提交结果表" /></label>
          <button className="primary" type="button" disabled={busy === note.id || (note.verification_mode === "mentor_verify" && !(completionNotes[note.id] || "").trim())} onClick={() => void update(note, "complete")}>{busy === note.id ? "保存中…" : note.verification_mode === "mentor_verify" ? note.student_reported_at ? "更新完成说明" : "提交完成说明" : "标记完成"}</button>
        </footer> : <footer className="completed"><span>✓ {note.completed_by_name || "已完成"}{note.completed_at ? ` · ${shortDate(note.completed_at)}` : ""}</span>{note.completion_note ? <p>{note.completion_note}</p> : null}</footer>}
      </article>)}
      {!visibleNotes.length ? <div className="student-portal-empty">目前没有导师指导事项。</div> : null}
    </div>}
    {compact && notes.length > visibleNotes.length ? <a className="student-guidance-more" href={studentNavigationHref({ view: "mentor" })}>查看全部导师指导 ›</a> : null}
    {message ? <p className="student-meeting-message" role={notes.length ? "status" : "alert"}>{message}<button type="button" onClick={() => void load().catch((error: Error) => setMessage(error.message))}>{notes.length ? "刷新状态" : "重新读取"}</button></p> : null}
  </section>;
}

function StudentMeetingRequests({ onToast, onRefresh }: {
  onToast: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [requests, setRequests] = useState<MeetingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | "create" | null>(null);
  const [message, setMessage] = useState("");
  const minimumDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/meeting-requests", { cache: "no-store" });
      const payload = (await response.json()) as { requests?: MeetingRequest[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "预约读取失败");
      setRequests(payload.requests ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: Error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy("create"); setMessage("");
    try {
      const response = await fetch("/api/meeting-requests", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": mutationKeyForForm(form) },
        body: JSON.stringify({
          preferredDate: values.preferredDate,
          preferredTime: values.preferredTime,
          durationMinutes: Number(values.durationMinutes),
          topic: values.topic,
          note: values.note,
        }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "预约提交失败");
      clearMutationKey(form);
      form.reset();
      onToast(payload.message || "会议预约已提交");
      await Promise.all([load(), onRefresh()]);
    } catch (error) { setMessage(error instanceof Error ? error.message : "预约提交失败"); }
    finally { setBusy(null); }
  }

  async function cancelRequest(item: MeetingRequest) {
    if (!window.confirm(`确认取消 ${item.preferred_date} ${item.preferred_time} 的会议预约？`)) return;
    setBusy(item.id); setMessage("");
    try {
      const response = await fetch("/api/meeting-requests", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action: "cancel", expectedVersion: item.version }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) {
        if (response.status === 409) await Promise.all([load(), onRefresh()]);
        throw new Error(payload.error || "取消预约失败");
      }
      onToast(payload.message || "预约已取消");
      await Promise.all([load(), onRefresh()]);
    } catch (error) { setMessage(error instanceof Error ? error.message : "取消预约失败"); }
    finally { setBusy(null); }
  }

  return <section className="student-portal-panel student-meeting-panel" id="student-meeting-form" tabIndex={-1}>
    <div className="student-portal-panel-head"><div><span>找导师聊聊</span><h2>约个时间</h2><p>选时间，简单写一下想聊什么。</p></div></div>
    <form className="student-meeting-form" onSubmit={createRequest} aria-busy={busy === "create"}>
      <div><label>希望日期<input type="date" name="preferredDate" min={minimumDate} required /></label><label>希望时间<input type="time" name="preferredTime" required /></label></div>
      <label>会议时长<select name="durationMinutes" defaultValue="30"><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option></select></label>
      <label>想聊什么<input name="topic" maxLength={200} required placeholder="例如：想确认下一轮实验怎么做" /></label>
      <label>还有什么要说明（可选）<textarea name="note" rows={3} maxLength={2000} placeholder="简单写几句即可，不要放保密材料" /></label>
      <button className="primary" disabled={busy === "create"}>{busy === "create" ? "提交中…" : "发给导师"}</button>
    </form>
    {message ? <p className="student-meeting-message" role={requests.length ? "status" : "alert"}>{message}<button type="button" onClick={() => void load().catch((error: Error) => setMessage(error.message))}>{requests.length ? "刷新状态" : "重新读取"}</button></p> : null}
    <div className="student-meeting-history"><h3>我的预约</h3>{loading ? <p>正在读取…</p> : requests.map((item) => <article key={item.id} id={`student-meeting-${item.id}`} tabIndex={-1}>
      <div><span className={`meeting-state ${item.status}`}>{meetingStatusLabels[item.status]}</span><time>{item.preferred_date} {item.preferred_time}</time></div>
      <strong>{item.topic}</strong><small>{item.duration_minutes} 分钟{item.handled_by_name ? ` · ${item.handled_by_name} 处理` : ""}</small>
      {item.response_note ? <p>{item.response_note}</p> : null}
      {item.status === "requested" || item.status === "confirmed" ? <button disabled={busy === item.id} onClick={() => void cancelRequest(item)}>{busy === item.id ? "处理中…" : "取消预约"}</button> : null}
    </article>)}{!loading && !requests.length ? <p>暂无预约记录</p> : null}</div>
  </section>;
}

function StaffMeetingRequests({ requests, loadError, onChanged }: {
  requests: MeetingRequest[];
  loadError: string;
  onChanged: () => Promise<void>;
}) {
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  async function handle(item: MeetingRequest, action: "confirm" | "decline") {
    const responseNote = (notes[item.id] || "").trim();
    if (action === "decline" && !responseNote) { setMessage("拒绝预约时必须填写具体回复"); return; }
    setBusy(item.id); setMessage("");
    try {
      const response = await fetch("/api/meeting-requests", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, action, expectedVersion: item.version, responseNote }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "预约处理失败");
      setMessage(payload.message || "预约状态已更新");
      setNotes((current) => ({ ...current, [item.id]: "" }));
      await onChanged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "预约处理失败"); }
    finally { setBusy(null); }
  }

  return <section className="panel staff-meeting-requests">
    <PanelHeader title="学生会议预约" subtitle="管理员（导师）只处理已分配且可审核的学生；超级管理员可全局协调" count={requests.filter((item) => item.status === "requested").length} />
    {loadError ? <div className="account-message" role="alert">{loadError}<button type="button" onClick={() => void onChanged()}>重新读取</button></div> : null}
    <div className="staff-meeting-list">{requests.map((item) => <article key={item.id}>
      <div className="staff-meeting-main"><span className={`meeting-state ${item.status}`}>{meetingStatusLabels[item.status]}</span><strong>{item.student_name} · {item.topic}</strong><small>{item.preferred_date} {item.preferred_time} · {item.duration_minutes} 分钟</small>{item.note ? <p>{item.note}</p> : null}{item.response_note ? <p>回复：{item.response_note}</p> : null}</div>
      {item.status === "requested" ? <div className="staff-meeting-actions"><label>回复意见<textarea rows={2} value={notes[item.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} maxLength={2000} placeholder="拒绝时必填；确认时可选" /></label><div><button disabled={busy === item.id} onClick={() => void handle(item, "decline")}>拒绝预约</button><button className="primary" disabled={busy === item.id} onClick={() => void handle(item, "confirm")}>确认时间</button></div></div> : null}
    </article>)}{!requests.length ? <div className="empty-small">当前没有会议预约。</div> : null}</div>
    {message ? <div className="account-message" role="status">{message}</div> : null}
  </section>;
}

function PanelHeader({ title, subtitle, action, onAction, count }: { title: string; subtitle?: string; action?: string; onAction?: () => void; count?: number }) {
  return <div className="panel-head"><div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>{action ? <button className="text-button" onClick={onAction}>{action}</button> : count !== undefined ? <span className="count">{count}</span> : null}</div>;
}

function OverviewMetrics({ data }: { data: DashboardData }) {
  if (data.viewer.role === "student") {
    const student = data.students[0];
    const substantive = student?.progress.filter((entry) => entry.status === "substantive").length ?? 0;
    return <section className="metric-grid" aria-label="个人科研概况">
      <article className="metric"><span>我的进展记录</span><strong>{student?.progress.length ?? 0}</strong><small>仅包含本人提交与纪要拆分记录</small></article>
      <article className="metric"><span>实质性进展</span><strong>{substantive}</strong><small className="positive">经导师确认后计入最近进展</small></article>
      <article className="metric"><span>等待导师确认</span><strong>{data.metrics.pending}</strong><small>保留原始证据与提交时间</small></article>
      <article className="metric attention"><span>当前培养状态</span><strong className="metric-risk-text">{student?.risk.level ?? "正常"}</strong><small>{student?.risk.days ?? 0} 天距最近实质性进展</small></article>
    </section>;
  }
  return <section className="metric-grid" aria-label="课题组概况">
    <article className="metric"><span>{data.viewer.role === "admin" ? "负责学生" : "在组学生"}</span><strong>{data.metrics.total}</strong><small>{data.metrics.doctors} 博士 · {data.metrics.masters} 硕士</small></article>
    <article className="metric"><span>科研成果与资产</span><strong>{data.metrics.outputs}</strong><small className="positive">论文、数据、软件、专利与交付物</small></article>
    <article className="metric"><span>待我处理</span><strong>{data.metrics.pending + data.metrics.proposalPending + data.metrics.guidancePending + (data.metrics.resolutionPending ?? 0) + data.metrics.blocked}</strong><small>证据 {data.metrics.pending} · 方案 {data.metrics.proposalPending} · 验收 {data.metrics.guidancePending} · 节点 {data.metrics.blocked}</small></article>
    <article className="metric attention"><span>需要关注</span><strong>{data.metrics.attention}</strong><small>黄 {data.metrics.riskCounts.黄色 ?? 0} · 橙 {data.metrics.riskCounts.橙色 ?? 0} · 红 {data.metrics.riskCounts.红色 ?? 0}</small></article>
  </section>;
}

function StudentFilters({ query, setQuery, riskFilter, setRiskFilter, degreeFilter, setDegreeFilter }: {
  query: string;
  setQuery: (value: string) => void;
  riskFilter: "全部" | RiskLevel;
  setRiskFilter: (value: "全部" | RiskLevel) => void;
  degreeFilter: "全部" | Student["degree"];
  setDegreeFilter: (value: "全部" | Student["degree"]) => void;
}) {
  return <div className="filter-bar">{query ? <button type="button" className="text-button" onClick={() => setQuery("")}>清除搜索</button> : null}<div className="filter-groups"><div className="filter-set"><span>层次</span><div className="filter-chips degree-chips" role="group" aria-label="按培养层次筛选">{(["全部", "博士", "硕士"] as const).map((degree) => <button type="button" aria-pressed={degreeFilter === degree} className={degreeFilter === degree ? "selected" : ""} key={degree} onClick={() => setDegreeFilter(degree)}>{degree}</button>)}</div></div><div className="filter-set"><span>风险</span><div className="filter-chips" role="group" aria-label="按风险筛选">{(["全部", "正常", "黄色", "橙色", "红色"] as const).map((risk) => <button type="button" aria-pressed={riskFilter === risk} className={riskFilter === risk ? "selected" : ""} key={risk} onClick={() => setRiskFilter(risk)}>{risk}</button>)}</div></div></div></div>;
}

function StudentTable({ students }: { students: Student[] }) {
  return <div className="student-table"><div className="table-row table-head"><span>学生</span><span>当前阶段</span><span>关键位置</span><span>科研成果</span><span>状态</span></div>{students.map((student) => <a className="table-row student-row" key={student.id} href={`/students/${encodeURIComponent(student.id)}`} aria-label={`打开 ${student.name} 的档案与进展`}><div className="student-name"><div className="mini-avatar">{student.name.slice(-2)}</div><div><strong>{student.name}</strong><small>{student.gradeYear}级{student.degree} · 查看学生档案</small></div></div><div><span className="stage-tag">{student.stage}</span></div><div className="progress-copy"><strong>{student.nextMilestone || student.latestTitle || "待补充研究进展"}</strong><small><em>{student.nextMilestone ? "下一培养节点" : "最近进展"}</em>{student.nextMilestoneDate ? shortDate(student.nextMilestoneDate) : sinceText(student.risk.days)}</small></div><div className="output-count"><strong>{student.outputCount}</strong><small>论文/数据/软件等</small></div><div><span className={`risk ${student.risk.level}`}>{student.risk.level}</span></div></a>)}{!students.length ? <div className="empty-small">没有符合条件的学生</div> : null}</div>;
}

export function ProgressModal({ students, papers = [], fixedKind, onClose, onSaved }: {
  students: Student[];
  papers?: StudentPaper[];
  fixedKind?: "论文" | "项目";
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState(fixedKind ?? "文献");
  const [paperSelection, setPaperSelection] = useState(papers[0] ? String(papers[0].id) : "new");
  const [paperStage, setPaperStage] = useState<PaperStage>(papers[0]?.current_stage ?? "planning");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])") ?? []);
    focusable()[0]?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [onClose]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError("");
    const form = event.currentTarget;
    const formData = new FormData(form);
    formData.set("kind", fixedKind ?? kind);
    try {
      const response = await fetch("/api/progress", { method: "POST", headers: { "Idempotency-Key": mutationKeyForForm(form) }, body: formData });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "提交失败");
      clearMutationKey(form);
      await onSaved();
    } catch (submitError) { setFormError(submitError instanceof Error ? submitError.message : "提交失败"); setBusy(false); }
  }
  const paperProgress = kind === "论文";
  const selectedPaper = papers.find((paper) => String(paper.id) === paperSelection);
  const minimumDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  if (fixedKind === "论文") {
    return <div className="modal-layer" role="presentation"><div className="modal paper-progress-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="progress-dialog-title"><button className="close" aria-label="关闭提交论文进度对话框" onClick={onClose}>×</button><div className="modal-title"><span>论文阶段更新</span><h2 id="progress-dialog-title">论文推进到了哪一个可验证节点？</h2><p>按“当前阶段 → 本轮产出 → 下一行动 → 截止日期”提交，附件作为稿件版本证据保留。</p></div><form onSubmit={submit}>
      <input name="studentId" type="hidden" value={students[0]?.id ?? ""} />
      <div className="paper-form-section"><h3>1 · 选择论文</h3><label>论文<select value={paperSelection} onChange={(event) => { const value = event.target.value; setPaperSelection(value); setPaperStage(papers.find((paper) => String(paper.id) === value)?.current_stage ?? "planning"); }}>{papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}<option value="new">＋ 添加论文</option></select></label>{selectedPaper ? <><input type="hidden" name="paperId" value={selectedPaper.id} /><div className="selected-paper-summary"><b>{selectedPaper.paper_type}</b><span>{selectedPaper.target_venue || "目标期刊/会议待定"}</span><em>{paperDeadlineState(selectedPaper.planned_submission_date).label}</em></div><div className="form-row"><label>目标期刊 / 会议<input name="targetVenue" defaultValue={selectedPaper.target_venue} placeholder="待定可留空" /></label><label>修订后的计划投稿日期<input name="plannedSubmissionDate" type="date" defaultValue={selectedPaper.planned_submission_date ?? ""} required /></label></div></> : <div className="form-row"><label>论文题目<input name="paperTitle" required placeholder="可先填写暂定题目" /></label><label>论文类型<select name="paperType" defaultValue="期刊论文">{paperTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>目标期刊 / 会议（可选）<input name="targetVenue" placeholder="例如：NDT & E International" /></label><label>计划投稿日期<input name="plannedSubmissionDate" type="date" min={minimumDate} required /></label></div>}</div>
      <div className="paper-form-section"><h3>2 · 阶段与版本</h3><label>当前阶段<select name="paperStage" value={paperStage} onChange={(event) => setPaperStage(event.target.value as PaperStage)}>{paperStages.map((stage) => <option key={stage} value={stage}>{paperStageMeta[stage].label}</option>)}</select></label><div className="paper-gate-hint"><b>阶段门</b><span>{paperStageMeta[paperStage].gate}</span></div><div className="form-row"><label>本轮更新标题<input name="title" required placeholder="例如：完成方法与实验章节内审稿" /></label><label>稿件版本<input name="manuscriptVersion" required placeholder="例如：v0.3、内审稿 2、R1" /></label></div><label>本轮已完成<textarea name="summary" required rows={3} placeholder="只写已完成、可检查的章节、实验、修改或投稿动作" /></label><label>文字证据（可选）<textarea name="evidence" rows={2} placeholder="章节页码、图表编号、评审记录；也可以只上传稿件附件" /></label></div>
      <div className="paper-form-section"><h3>3 · 下一行动</h3><label>下一步<textarea name="nextAction" required rows={2} placeholder="例如：补充厚板数据消融实验并更新图 6" /></label><div className="form-row"><label>行动期限<input name="nextActionDueDate" type="date" min={minimumDate} required /></label><label>稿件编号 / DOI（投稿后可填）<input name="submissionIdentifier" placeholder="Manuscript ID、DOI 或送审编号" /></label></div><label>当前阻塞（可选）<textarea name="blocker" rows={2} placeholder="只写需要导师决策、资源或协作支持的问题；没有可留空" /></label></div>
      <input type="hidden" name="literatureRef" value="" /><input type="hidden" name="gitUrl" value="" />
      <label>稿件与证据附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>建议上传带版本号的稿件、回复信或关键图表；最多 5 个文件，单个不超过 50 MB，总计不超过 80 MB</small></label>
      {formError ? <p className="form-error">{formError}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "正在上传并提交…" : "提交论文进度"}</button></div>
    </form></div></div>;
  }

  if (fixedKind === "项目") {
    return <div className="modal-layer" role="presentation"><div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="progress-dialog-title"><button className="close" aria-label="关闭提交项目进度对话框" onClick={onClose}>×</button><div className="modal-title"><span>提交项目进度</span><h2 id="progress-dialog-title">项目取得了什么新进展？</h2><p>沿用原有项目进展流程，填写可核验的研发、交付或验收结果，并可上传文件。</p></div><form onSubmit={submit}>
      <input name="studentId" type="hidden" value={students[0]?.id ?? ""} />
      <label>进展标题<input name="title" required placeholder="例如：完成项目中期版本交付" /></label>
      <label>新增结论<textarea name="summary" required rows={3} placeholder="本次完成了哪些研发、交付或验收节点？" /></label>
      <label>文字证据（可选）<textarea name="evidence" rows={2} placeholder="版本号、验收记录、实验编号；也可以只上传附件" /></label>
      <input type="hidden" name="literatureRef" value="" /><label>私有 GitHub 链接（可选）<input name="gitUrl" type="url" placeholder="只保存 HTTPS 链接；完整代码由本地 Agent 读取" /></label>
      <label>项目附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件；单个不超过 50 MB，总计不超过 80 MB</small></label>
      {formError ? <p className="form-error">{formError}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "正在上传并提交…" : "提交项目进度"}</button></div>
    </form></div></div>;
  }

  return <div className="modal-layer" role="presentation"><div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="progress-dialog-title"><button className="close" aria-label="关闭提交进展对话框" onClick={onClose}>×</button><div className="modal-title"><span>新增进展记录</span><h2 id="progress-dialog-title">{paperProgress ? "论文推进到了哪一步？" : "这次工作产生了什么新信息？"}</h2><p>填写结论，并通过文字说明或附件提供可核验的证据。</p></div><form onSubmit={submit}><div className="form-row"><label>学生<select name="studentId" required defaultValue={students[0]?.id}>{students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.stage}</option>)}</select></label><label>进展类型<select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>{progressKinds.map((item) => <option key={item}>{item}</option>)}</select></label></div><label>进展标题<input name="title" required placeholder="例如：完成跨材料泛化验证" /></label><label>新增结论<textarea name="summary" required rows={3} placeholder="本次工作确认、排除或发现了什么？" /></label><label>文字证据（可选）<textarea name="evidence" rows={2} placeholder="实验编号、图表位置、评审记录；也可以只上传附件" /></label>{kind === "文献" ? <label>论文题目 / DOI<input name="literatureRef" required placeholder="至少提供可识别的论文题目或 DOI" /></label> : <input type="hidden" name="literatureRef" value="" />}<label>私有 GitHub 链接（可选）<input name="gitUrl" type="url" placeholder="只保存 HTTPS 链接；完整代码由本地 Agent 读取" /></label><label>进展附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件；单个不超过 50 MB，总计不超过 80 MB</small></label>{formError ? <p className="form-error">{formError}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "正在上传并提交…" : "提交给导师确认"}</button></div></form></div></div>;
}

function ProposalWorkspace({ viewer, students, onToast, initialSelectedId }: {
  viewer: DashboardData["viewer"];
  students: Student[];
  onToast: (message: string) => void;
  initialSelectedId?: number;
}) {
  const [proposals, setProposals] = useState<ResearchProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [authorStudentId, setAuthorStudentId] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/proposals", { cache: "no-store" });
      const payload = (await response.json()) as { proposals?: ResearchProposal[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "研究方案加载失败");
      const items = payload.proposals ?? [];
      setProposals(items);
      setSelectedId((current) => items.some((item) => item.id === current)
        ? current
        : items.find((item) => item.id === initialSelectedId)?.id ?? items.find((item) => item.status === "submitted")?.id ?? items[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "研究方案加载失败");
    } finally {
      setLoading(false);
    }
  }, [initialSelectedId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    function restoreProposal() {
      const requestedId = Number(new URL(window.location.href).searchParams.get("proposal"));
      const restoredId = proposals.find((proposal) => proposal.id === requestedId)?.id
        ?? proposals.find((proposal) => proposal.status === "submitted")?.id
        ?? proposals[0]?.id
        ?? null;
      setSelectedId(restoredId);
    }
    window.addEventListener("popstate", restoreProposal);
    return () => window.removeEventListener("popstate", restoreProposal);
  }, [proposals]);

  function selectProposal(id: number) {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("mentorView", "research");
    url.searchParams.set("researchTab", "proposals");
    url.searchParams.set("proposal", String(id));
    window.history[selectedId === id ? "replaceState" : "pushState"]({}, "", url);
  }

  const effectiveAuthorStudentId = students.some((student) => student.id === authorStudentId)
    ? authorStudentId
    : students[0]?.id ?? "";
  const authorStudent = students.find((item) => item.id === effectiveAuthorStudentId);
  const authorProposal = authorStudent ? proposals.find((item) => item.student_id === authorStudent.id) : undefined;
  const selected = proposals.find((item) => item.id === selectedId);
  const canAuthorProposal = viewer.role === "superadmin" || viewer.role === "admin";
  const showEditor = Boolean(canAuthorProposal && authorStudent && editing);
  const editable = canAuthorProposal && (!authorProposal || authorProposal.status === "draft" || authorProposal.status === "changes_requested");

  if (loading) return <div className="proposal-loading">正在读取研究方案与版本记录…</div>;
  if (error) return <div className="error-state"><strong>研究方案暂时未加载</strong><span>{error}</span><button onClick={() => void load()}>重试</button></div>;

  return <div className="proposal-workspace">
    <section className="proposal-principle">
      <div><span>TUM 流程借鉴</span><h2>管理员代录，授权管理员或超级管理员确认，方案与执行证据保持可追溯</h2><p>AI 可以检查结构、遗漏和风险，但不能代写最终方案，也不能替代负责人作出正式评价。</p></div>
      <div className="proposal-flow"><b>草稿</b><i>→</i><b>提交</b><i>→</i><b>批注修订</b><i>→</i><b>确认冻结</b></div>
    </section>

    {canAuthorProposal && authorStudent ? <section className="panel own-proposal-card">
      <PanelHeader title="代录研究方案" subtitle="仅限当前权限范围内的学生；提交后须由另一位有权人员审核" />
      <div className="own-proposal-body">
        <div>
          <label>选择学生<select value={effectiveAuthorStudentId} onChange={(event) => { setAuthorStudentId(event.target.value); setEditing(false); }}>{students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.gradeYear}级{student.degree}</option>)}</select></label>
          <span className={`proposal-status ${authorProposal?.status ?? "draft"}`}>{proposalStatusMeta[authorProposal?.status ?? "draft"].label}</span>
          <strong>{authorProposal?.title || "尚未建立研究方案"}</strong>
          <small>{authorProposal ? `${proposalStatusMeta[authorProposal.status].hint} · 当前第 ${authorProposal.current_version || 0} 版` : "从科学问题、技术路线和培养节点开始代录"}</small>
        </div>
        {editable ? <button className="primary" onClick={() => setEditing(true)}>{authorProposal ? "继续编辑" : "开始代录"}</button> : null}
      </div>
      {authorProposal?.status === "changes_requested" && authorProposal.reviewer_note ? <div className="proposal-review-note"><b>导师修改意见</b><p>{authorProposal.reviewer_note}</p></div> : null}
    </section> : null}

    {showEditor && authorStudent ? <ProposalEditor
      student={authorStudent}
      proposal={authorProposal}
      onCancel={() => setEditing(false)}
      onSaved={async (message) => { onToast(message); setEditing(false); await load(); }}
    /> : null}

    {viewer.role !== "student" ? <section className="proposal-admin-layout">
      <div className="panel proposal-list-panel">
        <PanelHeader title={viewer.role === "admin" ? "负责学生的研究方案" : "全部研究方案"} subtitle="优先显示待审核与待修改方案" count={proposals.length} />
        <div className="proposal-list">
          {proposals.map((proposal) => <button key={proposal.id} className={selectedId === proposal.id ? "selected" : ""} onClick={() => selectProposal(proposal.id)}>
            <span className={`proposal-status ${proposal.status}`}>{proposalStatusMeta[proposal.status].label}</span>
            <strong>{proposal.student_name}</strong>
            <small>{proposal.title} · 第 {proposal.current_version || 0} 版</small>
          </button>)}
          {!proposals.length ? <div className="empty-small">管理员为负责学生建立研究方案后会显示在这里。</div> : null}
        </div>
      </div>
      <div>{selected ? <ProposalDetail key={selected.id} proposal={selected} canReview={selected.can_review} onToast={onToast} onRefresh={load} /> : <div className="empty-state"><span>◇</span><strong>暂无研究方案</strong><small>由管理员为负责学生建立并代录研究方案。</small></div>}</div>
    </section> : null}
  </div>;
}

function ProposalEditor({ student, proposal, onCancel, onSaved }: {
  student: Student;
  proposal?: ResearchProposal;
  onCancel: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [milestones, setMilestones] = useState<Array<{ id: number | null; title: string; targetDate: string; evidenceTarget: string; status: MilestoneStatus }>>(
    proposal?.milestones.map((item) => ({ id: item.id, title: item.title, targetDate: item.target_date, evidenceTarget: item.evidence_target, status: item.status }))
      ?? [{ id: null, title: "", targetDate: "", evidenceTarget: "", status: "pending" }],
  );
  const [busy, setBusy] = useState<"draft" | "submit" | null>(null);
  const [formError, setFormError] = useState("");

  function updateMilestone(index: number, key: "title" | "targetDate" | "evidenceTarget", value: string) {
    setMilestones((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const mode = submitter?.value === "submit" ? "submit" : "draft";
    setBusy(mode); setFormError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch("/api/proposals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, studentId: student.id, mode, milestones }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "研究方案保存失败");
      await onSaved(payload.message || (mode === "submit" ? "研究方案已提交" : "草稿已保存"));
    } catch (submitError) {
      setFormError(submitError instanceof Error ? submitError.message : "研究方案保存失败");
    } finally { setBusy(null); }
  }

  return <section className="panel proposal-editor">
    <PanelHeader title="撰写研究方案" subtitle="允许先保存不完整草稿；提交审核前必须补齐核心内容和培养节点" />
    <form onSubmit={submit}>
      <div className="proposal-form-intro"><strong>{student.name}</strong><span>{student.gradeYear}级{student.degree} · 由学生本人承担方案内容责任</span></div>
      <label>方案题目<input name="title" defaultValue={proposal?.title === "未命名方案" ? "" : proposal?.title} placeholder="用一句话准确描述研究对象、问题与方法" /></label>
      <div className="proposal-form-grid">
        <label>科学问题<textarea name="scientificQuestion" rows={4} defaultValue={proposal?.scientific_question} placeholder="要解释、验证或解决的核心科学问题是什么？" /></label>
        <label>研究假设<textarea name="hypothesis" rows={4} defaultValue={proposal?.hypothesis} placeholder="可被证据支持或否定的假设；探索性研究可说明暂无预设假设" /></label>
        <label>研究目标<textarea name="objectives" rows={4} defaultValue={proposal?.objectives} placeholder="列出可验收的总体目标和分目标" /></label>
        <label>创新点<textarea name="innovation" rows={4} defaultValue={proposal?.innovation} placeholder="相对已有工作的新增认识、方法或应用价值" /></label>
        <label>文献依据<textarea name="literatureBasis" rows={5} defaultValue={proposal?.literature_basis} placeholder="说明研究现状、空白和方案选择依据" /></label>
        <label>技术路线与方法<textarea name="methodology" rows={5} defaultValue={proposal?.methodology} placeholder="数据、变量、对照、实验或理论方法、统计分析与复现方式" /></label>
        <label>数据、伦理与安全<textarea name="dataEthics" rows={4} defaultValue={proposal?.data_ethics} placeholder="数据来源、授权、隐私、伦理审批和保密边界；不适用也请说明" /></label>
        <label>风险与备选方案<textarea name="risks" rows={4} defaultValue={proposal?.risks} placeholder="关键失败模式、外部依赖、停止条件和替代路线" /></label>
        <label>资源需求<textarea name="resources" rows={3} defaultValue={proposal?.resources} placeholder="设备、算力、数据、经费、协作和导师决策需求" /></label>
        <label>参考文献<textarea name="referencesText" rows={3} defaultValue={proposal?.references_text} placeholder="论文题目、DOI 或可核验链接，每行一条" /></label>
      </div>

      <div className="milestone-editor">
        <div className="milestone-editor-head"><div><strong>培养节点与验收证据</strong><small>节点采用通过/未通过管理，不混入普通进展分。</small></div><button type="button" onClick={() => setMilestones((current) => [...current, { id: null, title: "", targetDate: "", evidenceTarget: "", status: "pending" }])}>＋ 添加节点</button></div>
        {milestones.map((milestone, index) => <div className="milestone-edit-row" key={index}>
          <b>{index + 1}</b>
          <input aria-label={`第${index + 1}个节点名称`} value={milestone.title} onChange={(event) => updateMilestone(index, "title", event.target.value)} placeholder="如：完成开题论证" />
          <input aria-label={`第${index + 1}个节点日期`} type="date" value={milestone.targetDate} onChange={(event) => updateMilestone(index, "targetDate", event.target.value)} />
          <input aria-label={`第${index + 1}个节点证据`} value={milestone.evidenceTarget} onChange={(event) => updateMilestone(index, "evidenceTarget", event.target.value)} placeholder="验收材料或材料说明" />
          <button type="button" aria-label={`删除第${index + 1}个节点`} disabled={milestones.length === 1} onClick={() => setMilestones((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
        </div>)}
      </div>

      <div className="proposal-ai-note"><b>AI 使用边界</b><span>可以检查结构、逻辑、遗漏和引用格式；不得代替学生形成最终研究判断，所有 AI 建议由学生核对并承担责任。</span></div>
      {formError ? <p className="form-error">{formError}</p> : null}
      <div className="proposal-form-actions"><button type="button" onClick={onCancel}>暂不编辑</button><button name="mode" value="draft" disabled={Boolean(busy)}>{busy === "draft" ? "保存中…" : "保存草稿"}</button><button className="primary" name="mode" value="submit" disabled={Boolean(busy)}>{busy === "submit" ? "提交中…" : "提交导师审核"}</button></div>
    </form>
  </section>;
}

function ProposalDetail({ proposal, canReview, onToast, onRefresh }: {
  proposal: ResearchProposal;
  canReview: boolean;
  onToast: (message: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [note, setNote] = useState(proposal.reviewer_note);
  const [busy, setBusy] = useState("");

  async function review(action: "approve" | "request_changes" | "reopen") {
    setBusy(action);
    try {
      const response = await fetch("/api/proposals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, proposalId: proposal.id, note }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "方案审核失败");
      onToast(payload.message || "方案状态已更新");
      await onRefresh();
    } catch (error) { onToast(error instanceof Error ? error.message : "方案审核失败"); }
    finally { setBusy(""); }
  }

  async function updateMilestone(milestoneId: number, status: MilestoneStatus) {
    setBusy(`milestone-${milestoneId}`);
    try {
      const response = await fetch("/api/proposals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_milestone", milestoneId, status }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "培养节点更新失败");
      onToast(payload.message || "培养节点已更新");
      await onRefresh();
    } catch (error) { onToast(error instanceof Error ? error.message : "培养节点更新失败"); }
    finally { setBusy(""); }
  }

  const details = [
    ["科学问题", proposal.scientific_question], ["研究假设", proposal.hypothesis],
    ["研究目标", proposal.objectives], ["创新点", proposal.innovation],
    ["文献依据", proposal.literature_basis], ["技术路线与方法", proposal.methodology],
    ["数据、伦理与安全", proposal.data_ethics], ["风险与备选方案", proposal.risks],
    ["资源需求", proposal.resources], ["参考文献", proposal.references_text],
  ].filter(([, value]) => Boolean(value));

  const auditLabels: Record<string, string> = {
    save_draft: "保存草稿", submit: "提交审核", approve: "导师确认",
    request_changes: "退回修改", reopen: "重开修订", milestone_update: "更新节点",
  };

  return <article className="panel proposal-detail">
    <div className="proposal-detail-head"><div><span className={`proposal-status ${proposal.status}`}>{proposalStatusMeta[proposal.status].label}</span><h2>{proposal.title}</h2><p>{proposal.student_name} · {proposal.grade_year}级{proposal.degree} · 第 {proposal.current_version || 0} 版</p></div><small>更新于 {shortDate(proposal.updated_at)}</small></div>
    {proposal.reviewer_note ? <div className="proposal-review-note"><b>导师意见</b><p>{proposal.reviewer_note}</p></div> : null}
    <div className="proposal-detail-grid">{details.map(([label, value]) => <section key={label}><span>{label}</span><p>{value}</p></section>)}</div>

    <section className="proposal-milestones"><div className="section-title"><div><h3>培养节点</h3><p>方案确认后，授权管理员或超级管理员可以更新执行状态；完成必须另有证据记录。</p></div><b>{proposal.milestones.filter((item) => item.status === "completed").length}/{proposal.milestones.length}</b></div>
      <div className="milestone-timeline">{proposal.milestones.map((milestone, index) => <div className={`milestone-item ${milestone.status}`} key={milestone.id}><i>{index + 1}</i><div><strong>{milestone.title}</strong><small>目标日期：{milestone.target_date || "待补充"}</small><p>{milestone.evidence_target || "尚未填写验收证据"}</p></div>{proposal.status === "approved" ? <select aria-label={`${milestone.title}状态；完成必须通过实质性进展审核`} value={milestone.status} disabled={busy === `milestone-${milestone.id}`} onChange={(event) => void updateMilestone(milestone.id, event.target.value as MilestoneStatus)}>{Object.entries(milestoneStatusLabels).filter(([value]) => value !== "completed" || milestone.status === "completed").map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <span>{milestoneStatusLabels[milestone.status]}</span>}</div>)}</div>
    </section>

    {canReview && (proposal.status === "submitted" || proposal.status === "approved") ? <section className="proposal-review-box"><label>{proposal.status === "submitted" ? "导师审核意见" : "重大调整说明"}<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder={proposal.status === "submitted" ? "退回修改时必须说明具体问题；确认时可记录验收意见" : "说明为什么需要重开方案并形成新版本"} /></label><div>{proposal.status === "submitted" ? <><button disabled={Boolean(busy)} onClick={() => void review("request_changes")}>退回修改</button><button className="primary" disabled={Boolean(busy)} onClick={() => void review("approve")}>确认并冻结</button></> : <button disabled={Boolean(busy)} onClick={() => void review("reopen")}>重开修订</button>}</div></section> : null}

    <div className="proposal-history-grid"><section><div className="section-title"><div><h3>版本历史</h3><p>每次正式提交生成不可覆盖的快照。</p></div></div><div className="history-list">{proposal.versions.map((version) => <div key={version.id}><b>V{version.version_number}</b><span>由 {version.submitted_by_name} 提交</span><small>{shortDate(version.created_at)}</small></div>)}{!proposal.versions.length ? <p>尚未正式提交版本。</p> : null}</div></section><section><div className="section-title"><div><h3>审计记录</h3><p>记录提交、审核和节点状态变化。</p></div></div><div className="audit-list">{proposal.audit.slice(0, 8).map((event) => <div key={event.id}><i /><span><strong>{auditLabels[event.action] || event.action}</strong><small>{event.actor_name} · {shortDate(event.created_at)}</small><p>{event.detail}</p></span></div>)}</div></section></div>
  </article>;
}

function FeishuModal({ viewer, onClose, onSwitchPersona, personaBusy, onLogout }: {
  viewer: DashboardData["viewer"];
  onClose: () => void;
  onSwitchPersona: (persona: "management" | "student") => Promise<void>;
  personaBusy: boolean;
  onLogout: () => Promise<void>;
}) {
  const roleLabel = viewer.role === "superadmin" ? "超级管理员" : viewer.role === "admin" ? "管理员（导师）" : "学生";
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])") ?? []);
    focusable()[0]?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [onClose]);
  return <div className="modal-layer" role="presentation">
    <div className="modal compact-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="feishu-dialog-title">
      <button className="close" aria-label="关闭" onClick={onClose}>×</button>
      <div className="modal-title"><span>账号</span><h2 id="feishu-dialog-title">{viewer.name}</h2><p>{roleLabel} · 飞书登录</p></div>
      {viewer.canSwitchPersona ? <div className="persona-modal-card">
        <strong>当前界面：{viewer.activePersona === "student" ? "学生端" : "管理端"}</strong>
        <button className="primary" type="button" disabled={personaBusy} onClick={() => void onSwitchPersona(viewer.activePersona === "student" ? "management" : "student")}>{personaBusy ? "正在切换…" : viewer.activePersona === "student" ? "返回管理端" : "打开本人学生端"}</button>
      </div> : null}
      <div className="modal-actions"><button type="button" onClick={() => void onLogout()}>退出账号</button></div>
    </div>
  </div>;
}

function MeetingView({ viewer, students, meetingRequests, meetingLoadError, onRemind, onToast, onMeetingChange }: {
  viewer: DashboardData["viewer"];
  students: Student[];
  meetingRequests: MeetingRequest[];
  meetingLoadError: string;
  onRemind: (student: Student) => Promise<void>;
  onToast: (message: string) => void;
  onMeetingChange: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [agendaOpen, setAgendaOpen] = useState(false);
  const [agendaBusy, setAgendaBusy] = useState(false);
  const [meetingDate, setMeetingDate] = useState("");
  const [agendas, setAgendas] = useState<MeetingAgenda[]>([]);
  const [agendaScheduleDates, setAgendaScheduleDates] = useState<Record<number, string>>({});
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);

  const loadOperationalData = useCallback(async () => {
    const [agendaResponse, reminderResponse] = await Promise.all([
      fetch("/api/meeting-agendas", { cache: "no-store" }),
      fetch("/api/feishu/reminders", { cache: "no-store" }),
    ]);
    const agendaPayload = await agendaResponse.json() as { agendas?: MeetingAgenda[]; error?: string };
    const reminderPayload = await reminderResponse.json() as { deliveries?: NotificationDelivery[]; error?: string };
    if (!agendaResponse.ok) throw new Error(agendaPayload.error || "议程读取失败");
    if (!reminderResponse.ok) throw new Error(reminderPayload.error || "提醒记录读取失败");
    setAgendas(agendaPayload.agendas ?? []);
    setDeliveries(reminderPayload.deliveries ?? []);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOperationalData().catch((error: Error) => onToast(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [loadOperationalData, onToast]);

  const due = students
    .map((student) => ({ student, remaining: student.cadenceDays - daysSinceSubstantiveProgress(student) }))
    .filter((item) => item.remaining <= 7)
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, 8);
  const agendaCandidates = [...students]
    .filter((student) => student.risk.level !== "正常" || student.cadenceDays - daysSinceSubstantiveProgress(student) <= 7 || student.milestones.some((milestone) => milestone.status === "blocked"))
    .sort((a, b) => {
      const aBlocked = a.milestones.some((milestone) => milestone.status === "blocked") ? 1 : 0;
      const bBlocked = b.milestones.some((milestone) => milestone.status === "blocked") ? 1 : 0;
      return bBlocked - aBlocked || b.risk.days - a.risk.days;
    })
    .slice(0, 8);

  function candidateReason(student: Student) {
    const blocked = student.milestones.find((milestone) => milestone.status === "blocked");
    if (blocked) return `培养节点“${blocked.title}”受阻，需要明确决策或资源`;
    if (student.risk.level !== "正常") return `${student.risk.days} 天无实质性进展，确认阻塞与下一步行动`;
    return `进入 ${student.cadenceDays} 天更新窗口，核对本周期证据`;
  }

  async function saveAgenda() {
    if (!agendaCandidates.length) return;
    setAgendaBusy(true);
    try {
      const response = await fetch("/api/meeting-agendas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "导师决策组会议程",
          meetingDate,
          items: agendaCandidates.map((student) => ({
            studentId: student.id,
            topic: student.nextMilestone ? `确认节点：${student.nextMilestone}` : "明确下一步行动",
            reason: candidateReason(student),
            durationMinutes: student.milestones.some((milestone) => milestone.status === "blocked") ? 15 : 10,
          })),
        }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "议程保存失败");
      onToast(payload.message || "组会议程已保存");
      await loadOperationalData();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "议程保存失败");
    } finally {
      setAgendaBusy(false);
    }
  }

  async function updateAgenda(agenda: MeetingAgenda, status: MeetingAgenda["status"], meetingDateOverride?: string) {
    setAgendaBusy(true);
    try {
      const response = await fetch("/api/meeting-agendas", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: agenda.id, status, meetingDate: meetingDateOverride, expectedUpdatedAt: agenda.updated_at }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "议程更新失败");
      onToast(payload.message || "议程状态已更新");
      await loadOperationalData();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "议程更新失败");
    } finally {
      setAgendaBusy(false);
    }
  }

  return <div className="meeting-workspace">
    <div className="meeting-grid">
      <section className="panel"><PanelHeader title="更新提醒" subtitle="只提醒进入个人周期窗口的学生；同一学生每天最多一次" count={due.length} /><div className="reminder-list">{due.map(({ student, remaining }) => {
        const lastDelivery = deliveries.find((delivery) => delivery.student_id === student.id);
        return <div key={student.id}><span>{remaining < 0 ? `逾期 ${Math.abs(remaining)} 天` : remaining === 0 ? "到期" : `${remaining} 天后`}</span><strong>{student.name}</strong><small>{student.cadenceDays} 天周期 · {student.stage}{lastDelivery?.sent_at ? ` · 上次提醒 ${shortDate(lastDelivery.sent_at)}` : ""}</small><button disabled={busy === student.id} onClick={async () => { setBusy(student.id); await onRemind(student); await loadOperationalData().catch(() => undefined); setBusy(null); }}>{busy === student.id ? "发送中…" : "飞书提醒"}</button></div>;
      })}{!due.length ? <div className="empty-small">未来 7 天没有需要提醒的学生</div> : null}</div></section>
      <section className="panel meeting-rule"><PanelHeader title="议程生成器" subtitle="优先处理阻塞、逾期和进入周期窗口的学生" count={agendaCandidates.length} /><div className="meeting-summary"><span>{agendaCandidates.reduce((sum, student) => sum + (student.milestones.some((milestone) => milestone.status === "blocked") ? 15 : 10), 0)}</span><strong>分钟建议讨论时长</strong><p>系统只排序，不自动作出科研评价；保存后可排期、执行并归档。</p><div className="agenda-generator-actions"><label>组会日期<input type="date" value={meetingDate} onChange={(event) => setMeetingDate(event.target.value)} /></label><button onClick={() => setAgendaOpen((current) => !current)}>{agendaOpen ? "收起预览" : "预览议程"}</button><button className="primary" disabled={agendaBusy || !agendaCandidates.length} onClick={() => void saveAgenda()}>{agendaBusy ? "保存中…" : "保存为议程"}</button></div>{agendaOpen ? <div className="agenda-list">{agendaCandidates.map((student, index) => <a key={student.id} href={`/students/${encodeURIComponent(student.id)}`}><b>{index + 1}</b><span><strong>{student.name} · {student.nextMilestone || "下一步行动"}</strong><small>{candidateReason(student)}</small></span><em>{student.milestones.some((milestone) => milestone.status === "blocked") ? "15 分钟" : "10 分钟"}</em></a>)}{!agendaCandidates.length ? <p>当前暂无需要优先讨论的学生。</p> : null}</div> : null}</div></section>
    </div>
    <section className="panel saved-agendas">
      <PanelHeader title="已保存议程" subtitle="草稿、排期和完成状态均持久保存" count={agendas.length} />
      <div className="saved-agenda-list">{agendas.slice(0, 8).map((agenda) => {
        const scheduleDate = agendaScheduleDates[agenda.id] ?? agenda.meeting_date ?? "";
        return <details key={agenda.id}>
          <summary><span className={`status-pill ${agenda.status === "completed" ? "safe" : agenda.status === "scheduled" ? "reviewing" : "pending"}`}>{agenda.status === "draft" ? "草稿" : agenda.status === "scheduled" ? "已排期" : agenda.status === "completed" ? "已完成" : "已取消"}</span><div><strong>{agenda.title}</strong><small>{agenda.meeting_date || "尚未排期"} · {agenda.items.length} 项 · {agenda.items.reduce((sum, item) => sum + item.duration_minutes, 0)} 分钟</small></div><i>展开</i></summary>
          <div className="saved-agenda-items">{agenda.items.map((item, index) => <a key={item.id} href={`/students/${encodeURIComponent(item.student_id)}`}><b>{index + 1}</b><span><strong>{item.student_name} · {item.topic}</strong><small>{item.reason}</small></span><em>{item.duration_minutes} 分钟</em></a>)}</div>
          <footer>{agenda.status === "draft" ? <><label>排期日期<input type="date" value={scheduleDate} onChange={(event) => setAgendaScheduleDates((current) => ({ ...current, [agenda.id]: event.target.value }))} /></label><button disabled={agendaBusy || !scheduleDate} onClick={() => void updateAgenda(agenda, "scheduled", scheduleDate)}>确认排期</button></> : null}{agenda.status === "scheduled" ? <button className="primary" disabled={agendaBusy} onClick={() => void updateAgenda(agenda, "completed")}>标记组会完成</button> : null}</footer>
        </details>;
      })}{!agendas.length ? <div className="empty-small">生成候选后保存，即可建立第一份可追踪议程。</div> : null}</div>
    </section>
    <section className="panel reminder-ledger"><PanelHeader title="提醒记录" count={deliveries.length} /><div>{deliveries.slice(0, 12).map((delivery) => <div key={delivery.id}><span className={`status-pill ${delivery.status === "sent" ? "safe" : delivery.status === "failed" ? "danger" : "pending"}`}>{delivery.status === "sent" ? "已送达" : delivery.status === "failed" ? "发送失败" : "发送中"}</span><strong>{delivery.student_name}</strong><small>{delivery.reason} · {shortDate(delivery.sent_at || delivery.created_at)}</small>{delivery.error_message ? <em>{delivery.error_message}</em> : null}</div>)}{!deliveries.length ? <div className="empty-small">尚无提醒记录。</div> : null}</div></section>
    <StaffMeetingRequests requests={meetingRequests} loadError={meetingLoadError} onChanged={onMeetingChange} />
    {viewer.role === "superadmin" ? <FeishuMeetingImports students={students} /> : null}
  </div>;
}

function FeishuMeetingImports({ students }: { students: Student[] }) {
  const [imports, setImports] = useState<FeishuMeetingImport[]>([]);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/feishu/meeting-imports", { cache: "no-store" });
    const payload = (await response.json()) as { imports?: FeishuMeetingImport[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "AI 会议总结加载失败");
    setImports(payload.imports ?? []);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: Error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function update(item: FeishuMeetingImport, action: "ignore" | "create_progress") {
    setBusy(item.id); setMessage("");
    try {
      const response = await fetch("/api/feishu/meeting-imports", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          importId: item.id,
          studentId: choices[item.id] || "",
          title: titles[item.id] || "AI 会议总结",
        }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "会议总结处理失败");
      setMessage(payload.message || "会议总结已处理");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "会议总结处理失败"); }
    finally { setBusy(null); }
  }

  return <section className="panel meeting-import-panel">
    <PanelHeader title="飞书 AI 会议总结自动归档" subtitle="自动按学生拆分个人科研进展；普通聊天不保存，也不会自动评价学生" count={imports.filter((item) => item.status === "pending").length} />
    <div className="meeting-import-boundary"><b>智能拆分</b><span>纪要能明确对应到学生时直接生成各自的个人进展；多人纪要按姓名标题分段。只有无法可靠归属的内容才留在这里人工处理。</span></div>
    <div className="meeting-import-list">{imports.map((item) => <article key={item.id}>
      <div className="meeting-import-head"><div><span className={`status-pill ${item.status === "pending" ? "pending" : "safe"}`}>{item.status === "pending" ? "无法自动归属" : "已拆分为个人进展"}</span><strong>{shortDate(item.message_created_at)} AI 会议总结</strong><small>识别依据：{item.detected_reason} · {item.message_type || "消息"}</small></div>{item.status === "pending" && !item.links.length ? <button disabled={busy === item.id} onClick={() => void update(item, "ignore")}>忽略</button> : null}</div>
      {item.status === "pending" ? <pre>{item.extracted_text}</pre> : null}
      {item.links.length ? <div className="meeting-import-links">{item.links.map((link) => <span key={link.id}>已生成 {link.student_name} 的个人进展 #{link.progress_entry_id}</span>)}</div> : null}
      {item.status === "pending" ? <div className="meeting-import-actions"><select aria-label="关联学生" required value={choices[item.id] || ""} onChange={(event) => setChoices((current) => ({ ...current, [item.id]: event.target.value }))}><option value="" disabled>请明确选择学生</option>{students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.stage}</option>)}</select><input aria-label="进展标题" value={titles[item.id] || ""} onChange={(event) => setTitles((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="无法自动拆分时的备用标题" /><button className="primary" disabled={busy === item.id || !choices[item.id]} onClick={() => void update(item, "create_progress")}>{busy === item.id ? "处理中…" : "人工归属此候选"}</button></div> : null}
    </article>)}{!imports.length ? <div className="empty-small">识别到智能纪要后，系统会自动拆分到对应学生的个人进展。</div> : null}</div>
    {message ? <div className="account-message">{message}</div> : null}
  </section>;
}

function SettingsView({ viewer, onFeishu, students, onRosterImported }: {
  viewer: DashboardData["viewer"];
  onFeishu: () => void;
  students: Student[];
  onRosterImported: () => Promise<void>;
}) {
  return <div className="settings-grid">
    {viewer.role === "superadmin" ? <ProductionReadinessPanel /> : null}
    {viewer.role === "superadmin" ? <RosterImport students={students} onImported={onRosterImported} /> : null}
    {viewer.role === "superadmin" ? <StudentAccessSetup /> : null}
    <section className="panel setting-card"><PanelHeader title="飞书集成" subtitle="登录、提醒与 AI 会议总结导入" /><div className="setting-body"><span className="status-pill safe">智能拆分已启用</span><p>普通聊天即时过滤；智能纪要会按学生姓名和汇报分段生成个人进展，归属不明确时才进入备用人工区。</p><button className="primary" onClick={onFeishu}>查看接入状态</button></div></section>
    <section className="panel setting-card"><PanelHeader title="GitHub 私有仓库" subtitle="代码只能由本地模型读取" /><div className="setting-body"><span className="status-pill safe">本地读取</span><p>网站只保存仓库链接、提交号和学生主动提交的摘要，不把完整代码发送给云端 GPT。</p><small>当前不启用在线 GitHub 授权；仓库访问由导师本地工作区单独管理。</small></div></section>
    <section className="panel setting-card"><PanelHeader title="开源流程参考" subtitle="TUM · Moodle · OSIRIS · eLabFTW" /><div className="setting-body"><p>设计参考了以下开源项目的方案管理、权限和审核流程。</p><div className="reference-links"><a href="https://github.com/ls1intum/thesis-management" target="_blank" rel="noreferrer">TUM</a><a href="https://github.com/moodle/moodle" target="_blank" rel="noreferrer">Moodle</a><a href="https://github.com/OSIRIS-Solutions/osiris" target="_blank" rel="noreferrer">OSIRIS</a><a href="https://github.com/elabftw/elabftw" target="_blank" rel="noreferrer">eLabFTW</a></div></div></section>
    <AccountManagement viewer={viewer} students={students} />
    <section className="panel setting-card"><PanelHeader title="AI 数据边界" subtitle="遵循已确认的 A / C / D 分类" /><div className="setting-body data-boundaries"><p><b>A</b>培养计划、进展记录、论文草稿可交给云端模型</p><p><b>C</b>代码仓库、专利及保密项目仅限本地模型</p><p><b>D</b>私人评价、身心健康、正式成绩不允许 AI 读取</p></div></section>
  </div>;
}

type ReadinessCheck = {
  id: string;
  label: string;
  status: "pass" | "fail" | "warning" | "manual";
  detail: string;
};

function ProductionReadinessPanel() {
  const [checks, setChecks] = useState<ReadinessCheck[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch("/api/health/ready", { cache: "no-store" });
      const payload = await response.json() as { ready?: boolean; checks?: ReadinessCheck[] };
      setReady(Boolean(payload.ready));
      setChecks(payload.checks ?? []);
      if (!payload.checks?.length) throw new Error("生产就绪状态没有返回检查结果");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "生产就绪状态读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const blocking = checks.filter((check) => check.status === "fail").length;
  return <section className="panel setting-card production-readiness-panel">
    <PanelHeader title="生产就绪控制台" subtitle="读取真实绑定、名册、角色与存储状态" />
    <div className="setting-body">
      <div className="production-readiness-summary"><span className={`status-pill ${ready ? "safe" : "pending"}`}>{loading ? "检查中" : ready ? "技术条件通过" : `${blocking} 项阻塞`}</span><p>网络访问和备份恢复需人工检查。</p><button type="button" onClick={() => void load()} disabled={loading}>{loading ? "正在检查…" : "重新检查"}</button></div>
      <div className="production-readiness-checks">{checks.map((check) => <div key={check.id} className={check.status}><i aria-hidden="true">{check.status === "pass" ? "✓" : check.status === "fail" ? "!" : check.status === "warning" ? "△" : "人"}</i><span><strong>{check.label}</strong><small>{check.detail}</small></span><em>{check.status === "pass" ? "通过" : check.status === "fail" ? "阻塞" : check.status === "warning" ? "提醒" : "人工验收"}</em></div>)}</div>
      {message ? <small role="status">{message}</small> : null}
    </div>
  </section>;
}

function RosterImport({ students, onImported }: { students: Student[]; onImported: () => Promise<void> }) {
  const imported = students.length === 26 && students.some((student) => student.id === "student-026");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function importRoster() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/roster", { method: "POST" });
      const payload = (await response.json()) as { error?: string; message?: string; total?: number };
      if (!response.ok) throw new Error(payload.error || "名册导入失败");
      setMessage(`${payload.message}，共 ${payload.total} 人`);
      await onImported();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "名册导入失败");
    } finally { setBusy(false); }
  }

  return <section className="panel setting-card"><PanelHeader title="真实学生名册" subtitle="仅超级管理员可以执行导入" /><div className="setting-body"><span className="status-pill safe">{imported ? "已导入 26 人" : "等待导入"}</span><p>{imported ? "12 名博士生、14 名硕士生已纳入管理；演示记录已停用归档。" : "导入已确认的 26 人名册，并保留现有演示数据作为停用归档。"}</p><button className="primary" disabled={busy || imported} onClick={() => void importRoster()}>{busy ? "正在导入…" : imported ? "名册已导入" : "导入已确认名册"}</button>{message ? <small>{message}</small> : null}</div></section>;
}

type StudentAccessRow = {
  id: string;
  name: string;
  verified: boolean;
  source: "email" | "mobile" | "existing_login" | null;
  status: "verified" | "existing_login" | "contact_required" | "conflict";
};

function StudentAccessSetup() {
  const [students, setStudents] = useState<StudentAccessRow[]>([]);
  const [configuredCount, setConfiguredCount] = useState(0);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const requestIdRef = useRef("");

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/student-access", { cache: "no-store" });
    const payload = await response.json() as {
      students?: StudentAccessRow[];
      configured_count?: number;
      complete?: boolean;
      error?: string;
    };
    if (!response.ok) throw new Error(payload.error || "学生飞书身份状态加载失败");
    setStudents(payload.students ?? []);
    setConfiguredCount(payload.configured_count ?? 0);
    setComplete(Boolean(payload.complete));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: Error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const required = students.filter((student) => student.status === "contact_required");
    if (!required.length || students.some((student) => student.status === "conflict")) return;
    const form = new FormData(formElement);
    const contacts = required.map((student) => ({
      studentId: student.id,
      kind: String(form.get(`kind-${student.id}`) || "email") as "email" | "mobile",
      value: String(form.get(`value-${student.id}`) || "").trim(),
    }));
    if (contacts.some((item) => !item.value)) {
      setMessage("请填写所有待核验学生的飞书普通联系邮箱或手机号");
      return;
    }
    if (!window.confirm(`将一次性向飞书核验 ${contacts.length} 名学生的联系信息，并为完整的 26 人名册预绑定登录权限。联系方式不会保存。确认执行吗？`)) return;
    setBusy(true); setMessage("");
    requestIdRef.current ||= crypto.randomUUID();
    try {
      const response = await fetch("/api/admin/student-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: requestIdRef.current, contacts }),
      });
      const payload = await response.json() as { error?: string; message?: string; verified_count?: number };
      if (!response.ok) throw new Error(payload.error || "学生飞书身份预绑定失败");
      formElement.reset();
      requestIdRef.current = "";
      setMessage(payload.message || `已预核验 ${payload.verified_count ?? 26} 名学生`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "学生飞书身份预绑定失败");
    } finally { setBusy(false); }
  }

  const hasConflict = students.some((student) => student.status === "conflict");
  const requiredCount = students.filter((student) => student.status === "contact_required").length;
  return <section className="panel student-access-panel">
    <PanelHeader title="学生飞书登录权限" subtitle="联系信息只用于向飞书换取本应用 Open ID，不保存姓名匹配结果、邮箱或手机号" count={configuredCount} />
    <div className="student-access-note"><b>{complete ? "26 / 26 已预绑定" : `${requiredCount} 人待核验`}</b><span>飞书“获取用户 ID”权限已开通。已有真实登录绑定的账号免填；其余学生必须全部核验成功才会整体写入。</span></div>
    <form ref={formRef} onSubmit={(event) => void submit(event)} autoComplete="off">
      <div className="student-access-list">{students.map((student) => <label className={`student-access-row ${student.status}`} key={student.id}>
        <span><strong>{student.name}</strong><small>{student.id}</small></span>
        {student.status === "contact_required" ? <>
          <select name={`kind-${student.id}`} aria-label={`${student.name} 联系方式类型`} defaultValue="email"><option value="email">普通联系邮箱</option><option value="mobile">手机号</option></select>
          <input name={`value-${student.id}`} aria-label={`${student.name} 飞书联系方式`} placeholder="仅用于本次飞书身份核验" autoComplete="off" spellCheck={false} />
        </> : <span className={`status-pill ${student.status === "conflict" ? "pending" : "safe"}`}>{student.status === "verified" ? "已预绑定" : student.status === "existing_login" ? "已由真实登录核验" : "存在冲突，需人工核对"}</span>}
      </label>)}</div>
      <div className="student-access-actions"><span>{hasConflict ? "检测到历史账号冲突，已禁止整批写入。" : complete ? "学生首次登录时会自动进入自己的独立页面。" : `还需填写 ${requiredCount} 名学生。`}</span><button type="button" disabled={busy || complete} onClick={() => { formRef.current?.reset(); requestIdRef.current = ""; setMessage(""); }}>清空全部</button><button className="primary" type="submit" disabled={busy || complete || hasConflict || !requiredCount}>{busy ? "正在向飞书核验…" : complete ? "已全部开通" : "核验并预绑定 26 人"}</button></div>
    </form>
    {message ? <div className="account-message" role="status">{message}</div> : null}
  </section>;
}

type ManagedUser = {
  id: number;
  display_name: string;
  avatar_url: string;
  role: "superadmin" | "admin" | "student" | "pending";
  student_id: string | null;
  student_name: string | null;
  admin_student_ids: string[];
  last_login_at: string;
};

const managedRoleLabels: Record<ManagedUser["role"], string> = {
  superadmin: "超级管理员",
  admin: "管理员（导师）",
  student: "学生",
  pending: "等待授权",
};

function AccountManagement({ viewer, students }: { viewer: DashboardData["viewer"]; students: Student[] }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [roleChoices, setRoleChoices] = useState<Record<number, ManagedUser["role"]>>({});
  const [adminChoices, setAdminChoices] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [bootstrapPending, setBootstrapPending] = useState(false);
  const [canBootstrapSuperAdmin, setCanBootstrapSuperAdmin] = useState(false);
  const [bootstrapSuperAdminUserId, setBootstrapSuperAdminUserId] = useState<number | null>(null);
  const [available, setAvailable] = useState(true);

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/users", { cache: "no-store" });
    const payload = (await response.json()) as {
      users?: ManagedUser[];
      superadmin_bootstrap_pending?: boolean;
      can_bootstrap_superadmin?: boolean;
      bootstrap_superadmin_user_id?: number | null;
      error?: string;
    };
    if (response.status === 403 && viewer.role === "admin") {
      setAvailable(false);
      return;
    }
    if (!response.ok) throw new Error(payload.error || "账号列表加载失败");
    setAvailable(true);
    const nextUsers = payload.users ?? [];
    setBootstrapPending(Boolean(payload.superadmin_bootstrap_pending));
    setCanBootstrapSuperAdmin(Boolean(payload.can_bootstrap_superadmin));
    setBootstrapSuperAdminUserId(payload.bootstrap_superadmin_user_id ?? null);
    setUsers(nextUsers);
    setRoleChoices(Object.fromEntries(nextUsers.map((user) => [user.id, user.role])));
    setChoices(Object.fromEntries(nextUsers.map((user) => [user.id, user.student_id || students[0]?.id || ""])));
    setAdminChoices(Object.fromEntries(nextUsers.map((user) => [user.id, user.admin_student_ids ?? []])));
  }, [students, viewer.role]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadUsers().catch((error: Error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [loadUsers]);

  async function updateUser(user: ManagedUser, forcedRole?: ManagedUser["role"]) {
    const role = forcedRole || roleChoices[user.id] || user.role;
    if (
      role !== user.role
      && ([role, user.role].includes("superadmin") || [role, user.role].includes("admin"))
      && !window.confirm(`确认将 ${user.display_name} 的角色从“${managedRoleLabels[user.role]}”调整为“${managedRoleLabels[role]}”？该操作会写入权限审计。`)
    ) return;
    setBusy(user.id); setMessage("");
    try {
      const response = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          role,
          studentId: role === "student" ? choices[user.id] || students[0]?.id : null,
          studentIds: role === "admin" ? adminChoices[user.id] || [] : [],
        }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "账号更新失败");
      setMessage(payload.message || "账号已更新");
      await loadUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号更新失败");
    } finally { setBusy(null); }
  }

  if (!available) return null;

  return <section className="panel account-panel">
    <PanelHeader title="飞书账号与高权限授权" subtitle="成员先完成一次飞书登录，再按已核验账号授予角色；所有高权变更均写入审计" count={users.length} />
    {bootstrapPending ? <div className="account-bootstrap-note"><b>首次超级管理员待初始化</b><span>{canBootstrapSuperAdmin ? "当前已核验管理员账号已绑定为唯一初始化目标；仅可将本人一次性升级为超级管理员，成功后入口自动关闭。" : "系统维护者核验并预绑定当前管理员的唯一飞书账号标识前，不能初始化首位超级管理员。"}</span></div> : null}
    <div className="account-list">{users.map((user) => {
      const selectedRole = roleChoices[user.id] || user.role;
      const assigned = adminChoices[user.id] || [];
      const isSelf = user.id === viewer.id;
      const canBootstrapSelf = isSelf
        && viewer.role === "admin"
        && user.role === "admin"
        && canBootstrapSuperAdmin
        && user.id === bootstrapSuperAdminUserId;
      const canEdit = !isSelf && viewer.role === "superadmin";
      const badge = managedRoleLabels[user.role];
      return <div className="account-row" key={user.id}>
        <div className="account-person"><div className="mini-avatar">{user.display_name.slice(0, 1)}</div><span><strong>{user.display_name}</strong><small>飞书成员 · 最近登录 {shortDate(user.last_login_at)}</small></span></div>
        {canBootstrapSelf ? <><span className="status-pill safe">{badge} · 当前账号</span>{user.student_name ? <span className="bound-student">本人学生记录：{user.student_name}</span> : null}<button className="bind" disabled={busy === user.id} onClick={() => void updateUser(user, "superadmin")}>{busy === user.id ? "初始化中…" : "一次性初始化为超级管理员"}</button></> : !canEdit ? <><span className={`status-pill ${user.role === "pending" ? "pending" : "safe"}`}>{badge}{isSelf ? " · 当前账号" : ""}</span>{user.student_name ? <span className="bound-student">本人学生记录：{user.student_name}</span> : null}</> : <>
          <div className="account-role-editor">
            <label>角色<select value={selectedRole} onChange={(event) => setRoleChoices((current) => ({ ...current, [user.id]: event.target.value as ManagedUser["role"] }))}>
              <option value="pending">等待授权</option><option value="student">学生</option><option value="admin">管理员（导师）</option>
              {viewer.role === "superadmin" ? <option value="superadmin">超级管理员</option> : null}
            </select></label>
            {selectedRole === "student" ? <label>绑定学生<select value={choices[user.id] || students[0]?.id || ""} onChange={(event) => setChoices((current) => ({ ...current, [user.id]: event.target.value }))}>{students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.stage}</option>)}</select></label> : null}
            {selectedRole === "admin" ? <fieldset className="admin-assignment"><legend>负责学生（{assigned.length}）</legend><div>{students.map((student) => <label key={student.id}><input type="checkbox" checked={assigned.includes(student.id)} onChange={(event) => setAdminChoices((current) => ({ ...current, [user.id]: event.target.checked ? [...(current[user.id] || []), student.id] : (current[user.id] || []).filter((id) => id !== student.id) }))} /><span>{student.name}</span><small>{student.degree}</small></label>)}</div></fieldset> : null}
          </div>
          <button className="bind" disabled={busy === user.id || (selectedRole === "student" && !students.length)} onClick={() => void updateUser(user)}>{busy === user.id ? "保存中…" : selectedRole === "superadmin" ? "授予超级管理员" : "保存授权"}</button>
        </>}
      </div>;
    })}{!users.length ? <div className="empty-small">成员第一次从飞书打开应用后，账号会出现在这里。</div> : null}</div>
    {message ? <div className="account-message" role="status">{message}</div> : null}
  </section>;
}

function FeishuAccessGate({ gate, onAuthenticated }: { gate: AuthGate; onAuthenticated: () => Promise<void> }) {
  const pending = gate.kind === "pending";
  const [status, setStatus] = useState<"checking" | "ready" | "authorizing" | "error">(pending ? "ready" : "checking");
  const [message, setMessage] = useState(gate.message);
  const [config, setConfig] = useState<{ configured: boolean; appId: string; sdkUrl: string } | null>(null);

  const authorize = useCallback(async (activeConfig: { configured: boolean; appId: string; sdkUrl: string }) => {
    if (!activeConfig.configured) {
      setStatus("ready");
      setMessage("网站端已经完成飞书接入代码，等待配置企业自建应用凭据。");
      return;
    }
    if (!window.h5sdk || !window.tt) {
      setStatus("authorizing");
      setMessage("正在跳转至飞书完成安全登录…");
      window.location.assign("/api/auth/feishu/browser/start");
      return;
    }
    setStatus("authorizing");
    window.h5sdk.error(() => {
      setStatus("error");
      setMessage("飞书环境鉴权失败，请检查应用主页和可用范围配置。");
    });
    window.h5sdk.ready(() => {
      window.tt?.requestAccess({
        appID: activeConfig.appId,
        scopeList: [],
        success: async ({ code }) => {
          try {
            const response = await fetch("/api/auth/feishu/exchange", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code }),
            });
            const payload = (await response.json()) as { error?: string };
            if (!response.ok) throw new Error(payload.error || "登录失败");
            await onAuthenticated();
          } catch (error) {
            setStatus("error");
            setMessage(error instanceof Error ? error.message : "飞书登录失败");
          }
        },
        fail: () => {
          setStatus("error");
          setMessage("未能取得飞书授权码，请确认应用已发布且账号在可用范围内。");
        },
      });
    });
  }, [onAuthenticated]);

  useEffect(() => {
    if (pending) return;
    let cancelled = false;
    fetch("/api/auth/feishu/config", { cache: "no-store" })
      .then(async (response) => (await response.json()) as { configured: boolean; appId: string; sdkUrl: string })
      .then((value) => {
        if (cancelled) return;
        setConfig(value);
        if (!value.configured) return void authorize(value);
        const existing = document.querySelector<HTMLScriptElement>(`script[src="${value.sdkUrl}"]`);
        if (existing) return void authorize(value);
        const script = document.createElement("script");
        script.src = value.sdkUrl;
        script.async = true;
        script.onload = () => { if (!cancelled) void authorize(value); };
        script.onerror = () => { if (!cancelled) { setStatus("error"); setMessage("飞书客户端组件加载失败，请稍后重试。"); } };
        document.head.appendChild(script);
      })
      .catch(() => {
        if (!cancelled) { setStatus("error"); setMessage("无法读取飞书应用配置。"); }
      });
    return () => { cancelled = true; };
  }, [authorize, pending]);

  const checkAccess = useCallback(async () => {
    setStatus("checking");
    try {
      await onAuthenticated();
    } finally {
      setStatus("ready");
    }
  }, [onAuthenticated]);

  const switchAccount = useCallback(async () => {
    setStatus("authorizing");
    setMessage("正在退出当前系统登录并切换飞书账号…");
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/api/auth/feishu/browser/start");
  }, []);

  const setup = gate.kind === "setup" || config?.configured === false;
  return <main className="access-shell"><section className="access-card"><div className="access-brand"><div className="brand-mark">探</div><div><strong>探研</strong><span>射线探伤 × AI</span></div></div><div className={`access-orb ${pending ? "pending" : ""}`}>{pending ? "✓" : "飞"}</div><p className="access-kicker">飞书企业自建应用</p><h1>{pending ? "飞书身份已验证" : setup ? "飞书接入等待应用配置" : "正在通过飞书安全登录"}</h1><p className="access-copy">{pending ? "当前账号已经完成飞书登录，现在只差系统角色授权，无需反复点击飞书授权。" : message}</p>{pending ? <><div className="access-pending-note"><strong>下一步由超级管理员处理</strong><span>请在“系统管理 → 飞书账号与高权限授权”中，为当前账号分配学生或导师角色。</span></div><div className="access-actions"><button className="primary" disabled={status === "checking" || status === "authorizing"} onClick={() => void checkAccess()}>{status === "checking" ? "检查中…" : "重新检查权限"}</button><button disabled={status === "authorizing"} onClick={() => void switchAccount()}>{status === "authorizing" ? "切换中…" : "切换飞书账号"}</button></div></> : null}{setup ? <div className="setup-steps"><span><b>1</b>创建企业自建应用并添加“网页应用”能力</span><span><b>2</b>将应用主页设为当前系统地址</span><span><b>3</b>安全配置 App ID 和 App Secret 后发布</span></div> : null}{!pending && (status === "authorizing" || status === "checking") ? <div className="access-loading"><i /><span>正在确认飞书环境…</span></div> : null}{!pending && status === "error" && config?.configured ? <button className="primary access-retry" onClick={() => void authorize(config)}>重新尝试飞书登录</button> : null}<div className="access-safe">不会把 App Secret、飞书访问凭证或完整代码发送给云端 GPT</div></section></main>;
}

function LoadingState() {
  return <div className="loading-grid" role="status" aria-label="正在加载工作台"><div /><div /><div /><div /><section /><aside /></div>;
}
