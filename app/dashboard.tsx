"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { paperDeadlineState, paperStageMeta, paperStages, paperTypes, type PaperStage } from "../lib/paper-progress";

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
  attachments: Array<{
    id: number;
    file_name: string;
    content_type: string;
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
  nextMilestone: string | null;
  nextMilestoneDate: string | null;
  outputCount: number;
  risk: { level: RiskLevel; days: number };
  progress: StudentProgress[];
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
  paper: StudentProgress["paper"];
  can_finalize: boolean;
  evidence_sources: StudentProgress["evidence_sources"];
  attachments: StudentProgress["attachments"];
  submitted_at: string;
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

type ViewerRole = "superadmin" | "admin" | "student";

function isReviewerRole(role: ViewerRole) {
  return role === "superadmin" || role === "admin";
}

type DashboardData = {
  viewer: {
    id: number;
    name: string;
    avatarUrl: string;
    role: ViewerRole;
    studentId: string | null;
  };
  students: Student[];
  papers: StudentPaper[];
  pending: PendingEntry[];
  workflowTasks: Array<{
    id: number;
    type: "proposal_review" | "blocked_milestone" | "overdue_milestone";
    studentId: string;
    studentName: string;
    title: string;
    detail: string;
    targetDate: string | null;
  }>;
  metrics: {
    total: number;
    doctors: number;
    masters: number;
    pending: number;
    proposalPending: number;
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
  { id: "overview", label: "总览", icon: "▦" },
  { id: "students", label: "学生", icon: "◎" },
  { id: "proposals", label: "研究方案", icon: "◇" },
  { id: "reviews", label: "进展审核", icon: "✓" },
  { id: "meetings", label: "组会与提醒", icon: "▣" },
  { id: "settings", label: "系统设置", icon: "⚙" },
] as const;

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

const DASHBOARD_REFERENCE_TIME = Date.now();

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

function daysSinceLatestSubmission(student: Student) {
  const latest = student.progress.reduce((value, entry) => Math.max(value, new Date(entry.submitted_at).getTime()), 0);
  if (!latest) return student.risk.days;
  return Math.max(0, Math.floor((DASHBOARD_REFERENCE_TIME - latest) / 86_400_000));
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<(typeof navItems)[number]["id"]>("overview");
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"全部" | RiskLevel>("全部");
  const [degreeFilter, setDegreeFilter] = useState<"全部" | Student["degree"]>("全部");
  const [submitOpen, setSubmitOpen] = useState(false);
  const [studentSubmitKind, setStudentSubmitKind] = useState<"论文" | "项目">("论文");
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<number | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  const [toast, setToast] = useState("");
  const [authGate, setAuthGate] = useState<AuthGate | null>(null);

  const loadDashboard = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/dashboard", { cache: "no-store" });
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
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDashboard(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDashboard]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

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

  async function review(entry: PendingEntry, action: string) {
    if (!entry.can_finalize) {
      setToast(entry.reviewer_name ? `该证据正在由 ${entry.reviewer_name} 审核` : "当前账号没有导师审核权限");
      return;
    }
    if ((action === "supplement" || action === "rejected") && !(reviewNotes[entry.id] || "").trim()) {
      setToast("退回补证或判定为非进展时，必须先填写具体理由");
      return;
    }
    setReviewBusy(entry.id);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, action, note: reviewNotes[entry.id] || "" }),
      });
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "审核失败");
      setToast(action === "start_review" ? "已接手审核" : action === "substantive" ? "已确认为实质性进展" : "审核结果已保存");
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
    return <FeishuAccessGate key={authGate.kind} gate={authGate} onAuthenticated={loadDashboard} />;
  }

  if (loading && !data) {
    return <main className="student-portal-shell"><LoadingState /></main>;
  }

  if (!data && error) {
    return <main className="student-portal-shell"><div className="error-state"><strong>系统暂时无法加载</strong><span>{error}</span><button onClick={() => void loadDashboard()}>重试</button></div></main>;
  }

  if (data?.viewer.role === "student") {
    const ownStudents = data.students.filter((student) => student.id === data.viewer.studentId);
    const ownPapers = data.papers.filter((paper) => paper.student_id === data.viewer.studentId);
    return <>
      <StudentPortal
        data={data}
        onSubmitProgress={(kind) => { setStudentSubmitKind(kind); setSubmitOpen(true); }}
        onRefresh={loadDashboard}
        onToast={setToast}
        onFeishu={() => setFeishuOpen(true)}
      />
      {submitOpen ? <ProgressModal students={ownStudents} papers={ownPapers} fixedKind={studentSubmitKind} onClose={() => setSubmitOpen(false)} onSaved={async () => { setSubmitOpen(false); setToast(`${studentSubmitKind}进度已提交，等待导师确认`); await loadDashboard(); }} /> : null}
      {feishuOpen ? <FeishuModal viewer={data.viewer} onClose={() => setFeishuOpen(false)} onLogout={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </>;
  }

  const visibleNavItems = navItems;

  const viewerRoleLabel = data?.viewer.role === "superadmin"
    ? "超级管理员"
    : data?.viewer.role === "admin" ? "管理员（导师）" : "学生";

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">探</div>
          <div><strong>探研</strong><span>射线探伤 × AI</span></div>
        </div>
        <nav aria-label="主导航">
          {visibleNavItems.map((item) => (
            <button className={`nav-item ${view === item.id ? "active" : ""}`} key={item.id} onClick={() => setView(item.id)}>
              <span>{item.icon}</span>{item.label}
              {item.id === "reviews" && data?.metrics.pending ? <b>{data.metrics.pending}</b> : null}
            </button>
          ))}
        </nav>
        <div className="privacy-note"><span>AI 数据边界已启用</span><small>代码与保密项目仅限本地模型</small></div>
        <div className="sidebar-foot">
          <div className="avatar">{data?.viewer.name.slice(0, 1) || "佘"}</div>
          <div><strong>{data?.viewer.name || "佘阳"}</strong><span>{viewerRoleLabel}</span></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{today}</p>
            <h1>{view === "overview" ? data?.viewer.role === "student" ? "我的科研进展" : "科研进展驾驶舱" : navItems.find((item) => item.id === view)?.label}</h1>
            <p className="subtitle">
              {view === "overview" ? data?.viewer.role === "student" ? "查看自己的培养计划、证据进展和下一步行动。" : "只关注新增证据、研究结论和需要您决策的事项。" : view === "proposals" ? "由管理员代录、授权管理员或超级管理员确认，每次修订均保留版本与审核记录。" : "以阶段内是否产生可验证的新信息为核心。"}
            </p>
          </div>
          <div className="top-actions">
            <button className="feishu connected" onClick={() => setFeishuOpen(true)}><i />飞书已登录</button>
            {data && (data.viewer.role === "superadmin" || data.viewer.role === "admin" || data.viewer.role === "student")
              ? <button className="primary" onClick={() => setSubmitOpen(true)}>＋ 提交进展</button> : null}
          </div>
        </header>

        {loading ? <LoadingState /> : null}
        {error ? <div className="error-state"><strong>数据暂时未加载</strong><span>{error}</span><button onClick={() => void loadDashboard()}>重试</button></div> : null}

        {!loading && !error && data && view === "overview" ? (
          <>
            <OverviewMetrics data={data} />

            <ActionBoard data={data} onReviews={() => setView("reviews")} onProposals={() => setView("proposals")} />

            <div className="content-grid">
              <section className="panel student-panel">
                <PanelHeader title="学生进展" subtitle="按距离上次实质性进展的时间排序" action={`查看全部 ${data.metrics.total} 人 →`} onAction={() => setView("students")} />
                <StudentFilters query={query} setQuery={setQuery} riskFilter={riskFilter} setRiskFilter={setRiskFilter} degreeFilter={degreeFilter} setDegreeFilter={setDegreeFilter} />
                <StudentTable students={filteredStudents.slice(0, 8)} />
              </section>

              <aside className="right-column">
                <section className="panel decisions">
                  <PanelHeader title={isReviewerRole(data.viewer.role) ? "待您确认" : "待审核确认"} subtitle="正式科研判断由对应主导师或超级管理员完成" count={data.metrics.pending} />
                  {data.pending.slice(0, 3).map((entry) => (
                    <a className="decision-card" key={entry.id} href={`/students/${encodeURIComponent(entry.student_id)}#evidence`} aria-label={`查看 ${entry.display_name} 的全部进展`}>
                      <span className={`decision-icon kind-${entry.kind}`}>{entry.kind.slice(0, 1)}</span>
                      <div><strong>{entry.display_name} · {entry.kind}</strong><small>{entry.title}</small></div><b>查看进展 ›</b>
                    </a>
                  ))}
                  {!data.pending.length ? <div className="empty-small">目前没有待审核记录</div> : null}
                </section>
                <section className="panel rule-card">
                  <PanelHeader title="预警规则" subtitle="最长 30 天必须更新一次" />
                  <div className="rule-line"><i className="dot normal" /><span><strong>正常</strong>30 天内有确认进展</span></div>
                  <div className="rule-line"><i className="dot yellow" /><span><strong>黄色</strong>30–59 天无实质进展</span></div>
                  <div className="rule-line"><i className="dot orange" /><span><strong>橙色</strong>60–89 天无实质进展</span></div>
                  <div className="rule-line"><i className="dot red" /><span><strong>红色</strong>90 天及以上无实质进展</span></div>
                </section>
              </aside>
            </div>
          </>
        ) : null}

        {!loading && !error && data && view === "students" ? (
          <section className="panel roster-panel">
            <PanelHeader title="全部学生" subtitle="博士与硕士均已纳入首批试用" count={filteredStudents.length} />
            <StudentFilters query={query} setQuery={setQuery} riskFilter={riskFilter} setRiskFilter={setRiskFilter} degreeFilter={degreeFilter} setDegreeFilter={setDegreeFilter} />
            <StudentTable students={filteredStudents} />
          </section>
        ) : null}

        {!loading && !error && data && view === "proposals" ? (
          <ProposalWorkspace viewer={data.viewer} students={data.students} onToast={setToast} />
        ) : null}

        {!loading && !error && data && view === "reviews" ? (
          <section className="review-layout">
            <div className="review-intro">
              <strong>{data.pending.length} 项待审核</strong>
              <span>实质性进展会更新学生的最近进展日期；其他判断保留记录，但不重置预警。</span>
            </div>
            {data.pending.map((entry) => (
              <article className="review-card" key={entry.id}>
                <div className="review-card-head">
                  <span className={`decision-icon kind-${entry.kind}`}>{entry.kind.slice(0, 1)}</span>
                  <div><h2>{entry.paper?.title || entry.title}</h2><p>{entry.display_name} · {entry.paper ? `${paperStageMeta[entry.paper.stage].label} · ${entry.paper.manuscript_version}` : entry.kind} · {shortDate(entry.submitted_at)}提交</p></div>
                  <a className="review-student-link" href={`/students/${encodeURIComponent(entry.student_id)}#evidence`}>查看学生全部进展 ↗</a>
                  <span className={`status-pill ${entry.review_status === "in_review" ? "reviewing" : "pending"}`}>
                    {entry.review_status === "in_review" ? `${entry.reviewer_name || "导师"}审核中` : "等待接手"}
                  </span>
                </div>
                <div className="review-evidence">
                  <div><span>新增结论</span><p>{entry.summary}</p></div>
                  <div><span>证据</span><p>{entry.evidence}</p></div>
                  {entry.literature_ref ? <div><span>论文 / DOI</span><p>{entry.literature_ref}</p></div> : null}
                </div>
                {entry.paper ? <div className="review-paper-plan"><div><span>下一行动</span><b>{entry.paper.next_action}</b></div><div><span>行动期限</span><b>{entry.paper.next_action_due_date}</b></div>{entry.paper.submission_identifier ? <div><span>稿件编号 / DOI</span><b>{entry.paper.submission_identifier}</b></div> : null}{entry.paper.blocker ? <div className="blocker"><span>当前阻塞</span><b>{entry.paper.blocker}</b></div> : null}</div> : null}
                <div className="evidence-source-list" aria-label="证据来源">
                  {entry.evidence_sources.filter((source) => source.source_type !== "attachment").map((source) => <span key={source.id}>
                    <b>{source.label}</b>
                    {source.source_ref ? source.source_type === "git" || source.source_type === "url" || source.source_type === "attachment"
                      ? <a href={source.source_ref} target={source.source_type === "attachment" ? undefined : "_blank"} rel={source.source_type === "attachment" ? undefined : "noreferrer"}>{source.source_type === "attachment" ? "下载附件" : "打开外部证据"}</a>
                      : <small>{source.source_ref}</small> : null}
                    {source.content_sha256 ? <em>指纹 {source.content_sha256}</em> : null}
                  </span>)}
                  {!entry.evidence_sources.some((source) => source.source_type !== "attachment") ? <span><b>历史文本证据</b><small>来源结构化将在下次补证时建立</small></span> : null}
                </div>
                {entry.attachments.length ? <div className="review-attachment-list" aria-label="进展附件">{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><span>附件</span><b>{attachment.file_name}</b><small>{fileSizeText(attachment.size_bytes)} · 指纹 {attachment.content_sha256}</small></a>)}</div> : null}
                <label className="review-note-field">审核意见
                  <textarea
                    rows={3}
                    value={reviewNotes[entry.id] || ""}
                    onChange={(event) => setReviewNotes((current) => ({ ...current, [entry.id]: event.target.value }))}
                    disabled={!entry.can_finalize}
                    placeholder="需要补充或判定为非进展时必须说明具体理由"
                  />
                </label>
                <div className="review-actions" aria-label="进展判断">
                  {entry.can_finalize ? <>
                    {entry.review_status === "submitted" ? <button disabled={reviewBusy === entry.id} onClick={() => void review(entry, "start_review")}>接手审核</button> : null}
                    <button disabled={reviewBusy === entry.id} className="approve" onClick={() => void review(entry, "substantive")}>实质性进展</button>
                    <button disabled={reviewBusy === entry.id} onClick={() => void review(entry, "supporting")}>支持性工作</button>
                    <button disabled={reviewBusy === entry.id || !(reviewNotes[entry.id] || "").trim()} title="请先填写具体理由" onClick={() => void review(entry, "supplement")}>需要补充</button>
                    <button disabled={reviewBusy === entry.id || !(reviewNotes[entry.id] || "").trim()} title="请先填写具体理由" onClick={() => void review(entry, "rejected")}>非进展</button>
                  </> : <p>{entry.reviewer_name ? `由 ${entry.reviewer_name} 审核中` : "当前账号无审核权"}</p>}
                </div>
              </article>
            ))}
            {!data.pending.length ? <div className="empty-state"><span>✓</span><strong>待审核记录已清空</strong><small>新的飞书提交会自动进入这里。</small></div> : null}
          </section>
        ) : null}

        {!loading && !error && data && view === "meetings" ? <MeetingView viewer={data.viewer} students={data.students} onRemind={sendReminder} /> : null}
        {!loading && !error && view === "settings" && data ? <SettingsView viewer={data.viewer} onFeishu={() => setFeishuOpen(true)} students={data.students} onRosterImported={async () => { setToast("真实学生名册已导入"); await loadDashboard(); }} /> : null}
      </section>

      {submitOpen && data ? <ProgressModal students={data.students} onClose={() => setSubmitOpen(false)} onSaved={async () => { setSubmitOpen(false); setToast("进展已提交，等待导师确认"); await loadDashboard(); }} /> : null}
      {feishuOpen && data ? <FeishuModal viewer={data.viewer} onClose={() => setFeishuOpen(false)} onLogout={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}

const meetingStatusLabels: Record<MeetingRequest["status"], string> = {
  requested: "待处理",
  confirmed: "已确认",
  declined: "未通过",
  cancelled: "已取消",
};

const studentReviewLabels: Record<StudentProgress["review_status"], string> = {
  submitted: "等待导师接手",
  in_review: "导师审核中",
  accepted: "审核通过",
  changes_requested: "需要补充证据",
  rejected: "未认定为进展",
};

function StudentPortal({ data, onSubmitProgress, onRefresh, onToast, onFeishu }: {
  data: DashboardData;
  onSubmitProgress: (kind: "论文" | "项目") => void;
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
  onFeishu: () => void;
}) {
  const student = data.students.find((item) => item.id === data.viewer.studentId);
  if (!student) return <main className="student-portal-shell"><div className="error-state"><strong>学生档案尚未绑定</strong><span>请联系管理员核对飞书账号与学生记录。</span></div></main>;
  const papers = data.papers.filter((paper) => paper.student_id === student.id);
  const paperEntries = student.progress.filter((entry) => entry.kind === "论文");
  const pendingCount = paperEntries.filter((entry) => entry.review_status === "submitted" || entry.review_status === "in_review").length;
  const latest = [...paperEntries].sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime())[0];
  const trackingPapers = papers.filter((paper) => paper.status === "active" || paper.status === "on_hold");
  const leadPaper = trackingPapers.find((paper) => paper.status === "active") ?? trackingPapers[0] ?? papers[0];
  const planned = trackingPapers
    .map((paper) => paper.planned_submission_date)
    .filter((value): value is string => Boolean(value))
    .sort()[0] ?? null;
  const deadline = paperDeadlineState(planned);
  return <main className="student-portal-shell">
    <header className="student-portal-header">
      <div className="brand"><div className="brand-mark">探</div><div><strong>探研</strong><span>学生个人工作台</span></div></div>
      <div className="student-account"><span className="avatar">{data.viewer.name.slice(0, 1)}</span><div><strong>{data.viewer.name}</strong><small>学生账号 · 仅本人数据</small></div><button type="button" onClick={onFeishu}>飞书账号</button></div>
    </header>

    <section className="student-portal-hero">
      <div><span className="student-portal-kicker">PAPER PROGRESS DESK</span><h1>{student.name}，推进你的论文</h1><p>按阶段门记录版本、证据、下一行动和截止日期；每次提交都保留导师反馈。</p></div>
      <div className="student-primary-actions">
        <button className="primary" type="button" onClick={() => onSubmitProgress("论文")}>＋ 提交论文进度</button>
        <button type="button" onClick={() => onSubmitProgress("项目")}>＋ 提交项目进度</button>
        <button type="button" onClick={() => document.getElementById("student-meeting-form")?.scrollIntoView({ behavior: "smooth", block: "start" })}>预约导师会议</button>
      </div>
    </section>

    <section className="student-portal-summary" aria-label="我的提交概况">
      <article><span>论文台账</span><strong>{papers.length}</strong><small>{latest ? `共 ${paperEntries.length} 次版本化更新` : "先建立第一篇论文"}</small></article>
      <article><span>当前阶段</span><strong>{leadPaper ? paperStageMeta[leadPaper.current_stage].label : "尚未开始"}</strong><small>{leadPaper?.title || "提交进度时可新建论文"}</small></article>
      <article><span>等待导师反馈</span><strong>{pendingCount}</strong><small>提交后由导师或超级管理员确认</small></article>
      <article className={deadline.overdue ? "overdue" : ""}><span>计划投稿</span><strong>{deadline.label}</strong><small>{planned || "请在论文台账中设置日期"}</small></article>
    </section>

    <div className="student-portal-grid">
      <StudentProgressPanel student={student} papers={papers} onRefresh={onRefresh} onToast={onToast} />
      <div className="student-portal-side"><StudentProjectProgressPanel student={student} onRefresh={onRefresh} onToast={onToast} /><StudentMeetingRequests onToast={onToast} /></div>
    </div>
    <footer className="student-portal-boundary">学生端仅管理本人的论文进度、项目进度、提交附件和会议预约；论文采用阶段台账，项目暂沿用原有进展流程。</footer>
  </main>;
}

function StudentProgressPanel({ student, papers, onRefresh, onToast }: {
  student: Student;
  papers: StudentPaper[];
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const entries = [...student.progress]
    .filter((entry) => entry.kind === "论文")
    .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime())
    .slice(0, 12);

  async function resubmit(event: FormEvent<HTMLFormElement>, entry: StudentProgress) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("id", String(entry.id));
    formData.set("kind", entry.kind);
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

  return <section className="student-portal-panel student-progress-feed">
    <div className="student-portal-panel-head"><div><span>PAPER REGISTER</span><h2>论文台账与版本进展</h2><p>一篇论文一条台账；每次更新记录阶段、稿件版本、下一行动与证据。</p></div><b>{entries.length}</b></div>
    <div className="student-paper-register">{papers.map((paper) => { const due = paperDeadlineState(paper.planned_submission_date); const deadlineLabel = paper.status === "published" ? "已发表" : paper.status === "accepted" ? "已录用" : due.label; return <article key={paper.id}>
      <div><span className={`paper-stage stage-${paper.current_stage}`}>{paperStageMeta[paper.current_stage].label}</span><em className={paper.status === "active" && due.overdue ? "overdue" : ""}>{deadlineLabel}</em></div>
      <h3>{paper.title}</h3><p>{paper.paper_type}{paper.target_venue ? ` · ${paper.target_venue}` : " · 目标期刊/会议待定"}</p>
      <footer><span>{paper.update_count} 次更新</span><span>{paper.pending_count ? `${paper.pending_count} 条待反馈` : "无待反馈"}</span></footer>
    </article>; })}{!papers.length ? <div className="student-portal-empty">尚未建立论文台账。第一次提交论文进度时，填写论文题目与计划投稿日期即可建立。</div> : null}</div>
    <div className="student-progress-feed-list">{entries.map((entry) => <article key={entry.id}>
      <div><span className={`student-state ${entry.review_status}`}>{studentReviewLabels[entry.review_status]}</span><time>{shortDate(entry.submitted_at)}</time></div>
      <h3>{entry.paper?.title || entry.title}</h3><small>{entry.paper ? `${paperStageMeta[entry.paper.stage].label} · ${entry.paper.manuscript_version}` : "历史论文进展"}</small><p>{entry.summary}</p>
      {entry.paper ? <dl className="student-paper-update-detail"><div><dt>下一行动</dt><dd>{entry.paper.next_action}</dd></div><div><dt>行动期限</dt><dd>{entry.paper.next_action_due_date}</dd></div>{entry.paper.submission_identifier ? <div><dt>稿件编号 / DOI</dt><dd>{entry.paper.submission_identifier}</dd></div> : null}{entry.paper.blocker ? <div className="blocker"><dt>当前阻塞</dt><dd>{entry.paper.blocker}</dd></div> : null}</dl> : null}
      {entry.attachments?.length ? <div className="student-attachment-list" aria-label="提交附件">{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><span>↧</span><b>{attachment.file_name}</b><small>{fileSizeText(attachment.size_bytes)}</small></a>)}</div> : null}
      {entry.reviewer_note ? <blockquote><b>导师反馈</b><span>{entry.reviewer_note}</span></blockquote> : null}
      {entry.review_status === "changes_requested" ? <details><summary>补充证据并重新提交</summary><form onSubmit={(event) => void resubmit(event, entry)}>
        <label>更新后的结论<textarea name="summary" rows={3} required defaultValue={entry.summary} /></label>
        <label>补充核验证据<textarea name="evidence" rows={3} required defaultValue={entry.evidence} /></label>
        {entry.kind === "文献" ? <label>论文题目 / DOI<input name="literatureRef" required defaultValue={entry.literature_ref} /></label> : <input type="hidden" name="literatureRef" value={entry.literature_ref || ""} />}
        {entry.paper ? <><input type="hidden" name="paperId" value={entry.paper.id} /><label>论文阶段<select name="paperStage" defaultValue={entry.paper.stage}>{paperStages.map((stage) => <option key={stage} value={stage}>{paperStageMeta[stage].label}</option>)}</select></label><label>稿件版本<input name="manuscriptVersion" required defaultValue={entry.paper.manuscript_version} /></label><label>下一行动<textarea name="nextAction" rows={2} required defaultValue={entry.paper.next_action} /></label><label>行动期限<input name="nextActionDueDate" type="date" required defaultValue={entry.paper.next_action_due_date} /></label><label>阻塞问题（可选）<textarea name="blocker" rows={2} defaultValue={entry.paper.blocker} /></label><label>稿件编号 / DOI（可选）<input name="submissionIdentifier" defaultValue={entry.paper.submission_identifier} /></label></> : null}
        <input name="gitUrl" type="hidden" value={entry.git_url || ""} />
        <label>补充附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件，单个不超过 20 MB，总计不超过 50 MB</small></label>
        <button className="primary" disabled={busy === entry.id}>{busy === entry.id ? "提交中…" : "重新提交"}</button>
      </form></details> : null}
    </article>)}{!entries.length ? <div className="student-portal-empty">尚无论文进度。提交第一条带稿件版本和下一行动的更新后，会在这里看到导师反馈。</div> : null}</div>
  </section>;
}

function StudentProjectProgressPanel({ student, onRefresh, onToast }: {
  student: Student;
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const entries = [...student.progress]
    .filter((entry) => entry.kind === "项目")
    .sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime())
    .slice(0, 8);

  async function resubmit(event: FormEvent<HTMLFormElement>, entry: StudentProgress) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    formData.set("id", String(entry.id));
    formData.set("kind", "项目");
    formData.set("title", entry.title);
    setBusy(entry.id);
    try {
      const response = await fetch("/api/progress", { method: "PATCH", body: formData });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "项目补证提交失败");
      onToast(payload.message || "项目补证已重新提交");
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "项目补证提交失败");
    } finally { setBusy(null); }
  }

  return <section className="student-portal-panel student-project-feed">
    <div className="student-portal-panel-head"><div><span>PROJECT PROGRESS</span><h2>项目进度</h2><p>保留原有提交、附件和导师反馈流程。</p></div><b>{entries.length}</b></div>
    <div className="student-progress-feed-list">{entries.map((entry) => <article key={entry.id}>
      <div><span className={`student-state ${entry.review_status}`}>{studentReviewLabels[entry.review_status]}</span><time>{shortDate(entry.submitted_at)}</time></div>
      <h3>{entry.title}</h3><small>项目进度</small><p>{entry.summary}</p>
      {entry.attachments?.length ? <div className="student-attachment-list" aria-label="项目附件">{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><span>↧</span><b>{attachment.file_name}</b><small>{fileSizeText(attachment.size_bytes)}</small></a>)}</div> : null}
      {entry.reviewer_note ? <blockquote><b>导师反馈</b><span>{entry.reviewer_note}</span></blockquote> : null}
      {entry.review_status === "changes_requested" ? <details><summary>补充证据并重新提交</summary><form onSubmit={(event) => void resubmit(event, entry)}>
        <label>更新后的结论<textarea name="summary" rows={3} required defaultValue={entry.summary} /></label>
        <label>补充核验证据<textarea name="evidence" rows={3} required defaultValue={entry.evidence} /></label>
        <input type="hidden" name="literatureRef" value="" /><label>私有 GitHub 链接（可选）<input name="gitUrl" type="url" defaultValue={entry.git_url} placeholder="仅支持 https://" /></label>
        <label>补充附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件，单个不超过 20 MB，总计不超过 50 MB</small></label>
        <button className="primary" disabled={busy === entry.id}>{busy === entry.id ? "提交中…" : "重新提交"}</button>
      </form></details> : null}
    </article>)}{!entries.length ? <div className="student-portal-empty">尚无项目进度；可从页面顶部的“提交项目进度”进入原有提交流程。</div> : null}</div>
  </section>;
}

function StudentMeetingRequests({ onToast }: { onToast: (message: string) => void }) {
  const [requests, setRequests] = useState<MeetingRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | "create" | null>(null);
  const [message, setMessage] = useState("");
  const minimumDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  const load = useCallback(async () => {
    const response = await fetch("/api/meeting-requests", { cache: "no-store" });
    const payload = (await response.json()) as { requests?: MeetingRequest[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "预约读取失败");
    setRequests(payload.requests ?? []);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: Error) => setMessage(error.message)).finally(() => setLoading(false)), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy("create"); setMessage("");
    try {
      const response = await fetch("/api/meeting-requests", {
        method: "POST", headers: { "Content-Type": "application/json" },
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
      form.reset();
      onToast(payload.message || "会议预约已提交");
      await load();
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
      if (!response.ok) throw new Error(payload.error || "取消预约失败");
      onToast(payload.message || "预约已取消");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "取消预约失败"); }
    finally { setBusy(null); }
  }

  return <section className="student-portal-panel student-meeting-panel" id="student-meeting-form">
    <div className="student-portal-panel-head"><div><span>MEETING REQUEST</span><h2>预约导师会议</h2><p>提交希望时间与议题，等待导师确认。</p></div></div>
    <form className="student-meeting-form" onSubmit={createRequest} aria-busy={busy === "create"}>
      <div><label>希望日期<input type="date" name="preferredDate" min={minimumDate} required /></label><label>希望时间<input type="time" name="preferredTime" required /></label></div>
      <label>会议时长<select name="durationMinutes" defaultValue="30"><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="45">45 分钟</option><option value="60">60 分钟</option></select></label>
      <label>会议议题<input name="topic" maxLength={200} required placeholder="例如：确认实验方案与下一步决策" /></label>
      <label>补充说明（可选）<textarea name="note" rows={3} maxLength={2000} placeholder="只写科研议题；不要填写健康、成绩、私人评价或保密原文" /></label>
      <button className="primary" disabled={busy === "create"}>{busy === "create" ? "提交中…" : "提交预约"}</button>
    </form>
    {message ? <p className="student-meeting-message" role="status">{message}</p> : null}
    <div className="student-meeting-history"><h3>我的预约</h3>{loading ? <p>正在读取…</p> : requests.map((item) => <article key={item.id}>
      <div><span className={`meeting-state ${item.status}`}>{meetingStatusLabels[item.status]}</span><time>{item.preferred_date} {item.preferred_time}</time></div>
      <strong>{item.topic}</strong><small>{item.duration_minutes} 分钟{item.handled_by_name ? ` · ${item.handled_by_name} 处理` : ""}</small>
      {item.response_note ? <p>{item.response_note}</p> : null}
      {item.status === "requested" || item.status === "confirmed" ? <button disabled={busy === item.id} onClick={() => void cancelRequest(item)}>{busy === item.id ? "处理中…" : "取消预约"}</button> : null}
    </article>)}{!loading && !requests.length ? <p>暂无预约记录</p> : null}</div>
  </section>;
}

function StaffMeetingRequests() {
  const [requests, setRequests] = useState<MeetingRequest[]>([]);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/meeting-requests", { cache: "no-store" });
    const payload = (await response.json()) as { requests?: MeetingRequest[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "会议预约读取失败");
    setRequests(payload.requests ?? []);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((error: Error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "预约处理失败"); }
    finally { setBusy(null); }
  }

  return <section className="panel staff-meeting-requests">
    <PanelHeader title="学生会议预约" subtitle="管理员（导师）只处理已分配且可审核的学生；超级管理员可全局协调" count={requests.filter((item) => item.status === "requested").length} />
    <div className="staff-meeting-list">{requests.map((item) => <article key={item.id}>
      <div className="staff-meeting-main"><span className={`meeting-state ${item.status}`}>{meetingStatusLabels[item.status]}</span><strong>{item.student_name} · {item.topic}</strong><small>{item.preferred_date} {item.preferred_time} · {item.duration_minutes} 分钟</small>{item.note ? <p>{item.note}</p> : null}{item.response_note ? <p>回复：{item.response_note}</p> : null}</div>
      {item.status === "requested" ? <div className="staff-meeting-actions"><label>回复意见<textarea rows={2} value={notes[item.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} maxLength={2000} placeholder="拒绝时必填；确认时可选" /></label><div><button disabled={busy === item.id} onClick={() => void handle(item, "decline")}>拒绝预约</button><button className="primary" disabled={busy === item.id} onClick={() => void handle(item, "confirm")}>确认时间</button></div></div> : null}
    </article>)}{!requests.length ? <div className="empty-small">当前没有会议预约。</div> : null}</div>
    {message ? <div className="account-message" role="status">{message}</div> : null}
  </section>;
}

function PanelHeader({ title, subtitle, action, onAction, count }: { title: string; subtitle: string; action?: string; onAction?: () => void; count?: number }) {
  return <div className="panel-head"><div><h2>{title}</h2><p>{subtitle}</p></div>{action ? <button className="text-button" onClick={onAction}>{action}</button> : count !== undefined ? <span className="count">{count}</span> : null}</div>;
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
    <article className="metric"><span>待我处理</span><strong>{data.metrics.pending + data.metrics.proposalPending + data.metrics.blocked}</strong><small>证据 {data.metrics.pending} · 方案 {data.metrics.proposalPending} · 节点 {data.metrics.blocked}</small></article>
    <article className="metric attention"><span>需要关注</span><strong>{data.metrics.attention}</strong><small>黄 {data.metrics.riskCounts.黄色 ?? 0} · 橙 {data.metrics.riskCounts.橙色 ?? 0} · 红 {data.metrics.riskCounts.红色 ?? 0}</small></article>
  </section>;
}

function ActionBoard({ data, onReviews, onProposals }: { data: DashboardData; onReviews: () => void; onProposals: () => void }) {
  const allRiskStudents = [...data.students]
    .filter((student) => student.risk.level !== "正常")
    .sort((a, b) => b.risk.days - a.risk.days);
  const allDueStudents = [...data.students]
    .filter((student) => student.risk.level === "正常" && student.cadenceDays - daysSinceLatestSubmission(student) <= 7)
    .sort((a, b) => (a.cadenceDays - daysSinceLatestSubmission(a)) - (b.cadenceDays - daysSinceLatestSubmission(b)));
  const riskStudents = allRiskStudents.slice(0, 3);
  const dueStudents = allDueStudents.slice(0, 3);
  const isStudent = data.viewer.role === "student";
  const staffTasks = [
    ...data.workflowTasks.map((task) => ({
      key: `${task.type}-${task.id}`,
      href: task.type === "proposal_review" ? "" : `/students/${encodeURIComponent(task.studentId)}#milestones`,
      action: task.type === "proposal_review" ? "proposals" as const : "link" as const,
      student: task.studentName,
      title: task.title,
      label: task.type === "proposal_review" ? "方案待审" : task.type === "blocked_milestone" ? "节点受阻" : "节点逾期",
    })),
    ...data.pending.map((entry) => ({
      key: `progress-${entry.id}`,
      href: `/students/${encodeURIComponent(entry.student_id)}#evidence`,
      action: "reviews" as const,
      student: entry.display_name,
      title: entry.title,
      label: entry.review_status === "in_review" ? "继续审核" : "证据待审",
    })),
  ];

  return <section className="panel action-board">
    <div className="action-board-head"><div><span>ROLE WORKSPACE</span><h2>{isStudent ? "我的下一步" : data.viewer.role === "superadmin" ? "超级管理员行动台" : "管理员（导师）行动台"}</h2><p>{isStudent ? "把等待反馈、当前状态和下次更新集中在一个入口。" : "先处理等待决策的事项，再跟进风险和即将到期的更新。"}</p></div><small>只给行动排序，不对学生综合评分</small></div>
    <div className="action-board-grid">
      <article><header><i className="review">审</i><div><strong>{isStudent ? "等待导师反馈" : "待我处理"}</strong><span>{isStudent ? data.pending.length : staffTasks.length} 项</span></div></header><div className="action-items">
        {isStudent ? data.pending.slice(0, 4).map((entry) => <a key={entry.id} href={`/students/${encodeURIComponent(entry.student_id)}#evidence`}><span><b>{entry.display_name}</b><small>{entry.title}</small></span><em>查看</em></a>) : staffTasks.slice(0, 4).map((task) => task.href ? <a key={task.key} href={task.href}><span><b>{task.student}</b><small>{task.title}</small></span><em>{task.label}</em></a> : <button key={task.key} onClick={task.action === "proposals" ? onProposals : onReviews}><span><b>{task.student}</b><small>{task.title}</small></span><em>{task.label}</em></button>)}
        {(isStudent ? !data.pending.length : !staffTasks.length) ? <p>目前没有等待处理的事项</p> : null}
      </div></article>
      <article><header><i className="risking">险</i><div><strong>{isStudent ? "当前培养状态" : "风险随访"}</strong><span>{allRiskStudents.length} 人</span></div></header><div className="action-items">{riskStudents.map((student) => <a key={student.id} href={`/students/${encodeURIComponent(student.id)}`}><span><b>{student.name}</b><small>{student.risk.days} 天无实质性进展</small></span><em className={`risk ${student.risk.level}`}>{student.risk.level}</em></a>)}{!riskStudents.length ? <p>当前没有需要风险随访的学生</p> : null}</div></article>
      <article><header><i className="due">期</i><div><strong>未来 7 天更新</strong><span>{allDueStudents.length} 人</span></div></header><div className="action-items">{dueStudents.map((student) => { const remaining = student.cadenceDays - daysSinceLatestSubmission(student); return <a key={student.id} href={`/students/${encodeURIComponent(student.id)}`}><span><b>{student.name}</b><small>{student.cadenceDays} 天个人更新周期</small></span><em>{remaining < 0 ? "已到期" : remaining === 0 ? "今天" : `${remaining} 天后`}</em></a>; })}{!dueStudents.length ? <p>未来 7 天暂无计划更新</p> : null}</div></article>
    </div>
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
  return <div className="filter-bar"><label><span aria-hidden="true">⌕</span><input aria-label="搜索学生" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索学生、阶段或研究方向" /></label><div className="filter-groups"><div className="filter-set"><span>层次</span><div className="filter-chips degree-chips" role="group" aria-label="按培养层次筛选">{(["全部", "博士", "硕士"] as const).map((degree) => <button type="button" aria-pressed={degreeFilter === degree} className={degreeFilter === degree ? "selected" : ""} key={degree} onClick={() => setDegreeFilter(degree)}>{degree}</button>)}</div></div><div className="filter-set"><span>风险</span><div className="filter-chips" role="group" aria-label="按风险筛选">{(["全部", "正常", "黄色", "橙色", "红色"] as const).map((risk) => <button type="button" aria-pressed={riskFilter === risk} className={riskFilter === risk ? "selected" : ""} key={risk} onClick={() => setRiskFilter(risk)}>{risk}</button>)}</div></div></div></div>;
}

function StudentTable({ students }: { students: Student[] }) {
  return <div className="student-table"><div className="table-row table-head"><span>学生</span><span>当前阶段</span><span>下一行动</span><span>科研成果</span><span>状态</span></div>{students.map((student) => <a className="table-row student-row" key={student.id} href={`/students/${encodeURIComponent(student.id)}`} aria-label={`打开 ${student.name} 的专属档案与全部进展`}><div className="student-name"><div className="mini-avatar">{student.name.slice(-2)}</div><div><strong>{student.name}</strong><small>{student.gradeYear}级{student.degree} · 点击查看专属档案</small></div></div><div><span className="stage-tag">{student.stage}</span></div><div className="progress-copy"><strong>{student.nextMilestone || student.latestTitle}</strong><small><em>{student.nextMilestone ? "培养节点" : student.latestKind}</em>{student.nextMilestoneDate ? shortDate(student.nextMilestoneDate) : sinceText(student.risk.days)}</small></div><div className="output-count"><strong>{student.outputCount}</strong><small>论文/数据/软件等</small></div><div><span className={`risk ${student.risk.level}`}>{student.risk.level}</span></div></a>)}{!students.length ? <div className="empty-small">没有符合条件的学生</div> : null}</div>;
}

function ProgressModal({ students, papers = [], fixedKind, onClose, onSaved }: {
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
    const formData = new FormData(event.currentTarget);
    formData.set("kind", fixedKind ?? kind);
    try {
      const response = await fetch("/api/progress", { method: "POST", body: formData });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "提交失败");
      await onSaved();
    } catch (submitError) { setFormError(submitError instanceof Error ? submitError.message : "提交失败"); setBusy(false); }
  }
  const paperProgress = kind === "论文";
  const selectedPaper = papers.find((paper) => String(paper.id) === paperSelection);
  const minimumDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  if (fixedKind === "论文") {
    return <div className="modal-layer" role="presentation"><div className="modal paper-progress-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="progress-dialog-title"><button className="close" aria-label="关闭提交论文进度对话框" onClick={onClose}>×</button><div className="modal-title"><span>论文阶段更新</span><h2 id="progress-dialog-title">论文推进到了哪一个可验证节点？</h2><p>按“当前阶段 → 本轮产出 → 下一行动 → 截止日期”提交，附件作为稿件版本证据保留。</p></div><form onSubmit={submit}>
      <input name="studentId" type="hidden" value={students[0]?.id ?? ""} />
      <div className="paper-form-section"><h3>1 · 选择论文</h3><label>论文台账<select value={paperSelection} onChange={(event) => { const value = event.target.value; setPaperSelection(value); setPaperStage(papers.find((paper) => String(paper.id) === value)?.current_stage ?? "planning"); }}>{papers.map((paper) => <option key={paper.id} value={paper.id}>{paper.title}</option>)}<option value="new">＋ 新建论文台账</option></select></label>{selectedPaper ? <><input type="hidden" name="paperId" value={selectedPaper.id} /><div className="selected-paper-summary"><b>{selectedPaper.paper_type}</b><span>{selectedPaper.target_venue || "目标期刊/会议待定"}</span><em>{paperDeadlineState(selectedPaper.planned_submission_date).label}</em></div><div className="form-row"><label>目标期刊 / 会议<input name="targetVenue" defaultValue={selectedPaper.target_venue} placeholder="待定可留空" /></label><label>修订后的计划投稿日期<input name="plannedSubmissionDate" type="date" defaultValue={selectedPaper.planned_submission_date ?? ""} required /></label></div></> : <div className="form-row"><label>论文题目<input name="paperTitle" required placeholder="填写暂定题目，后续版本沿用同一台账" /></label><label>论文类型<select name="paperType" defaultValue="期刊论文">{paperTypes.map((type) => <option key={type}>{type}</option>)}</select></label><label>目标期刊 / 会议（可选）<input name="targetVenue" placeholder="例如：NDT & E International" /></label><label>计划投稿日期<input name="plannedSubmissionDate" type="date" min={minimumDate} required /></label></div>}</div>
      <div className="paper-form-section"><h3>2 · 阶段与版本</h3><label>当前阶段<select name="paperStage" value={paperStage} onChange={(event) => setPaperStage(event.target.value as PaperStage)}>{paperStages.map((stage) => <option key={stage} value={stage}>{paperStageMeta[stage].label}</option>)}</select></label><div className="paper-gate-hint"><b>阶段门</b><span>{paperStageMeta[paperStage].gate}</span></div><div className="form-row"><label>本轮更新标题<input name="title" required placeholder="例如：完成方法与实验章节内审稿" /></label><label>稿件版本<input name="manuscriptVersion" required placeholder="例如：v0.3、内审稿 2、R1" /></label></div><label>本轮已完成<textarea name="summary" required rows={3} placeholder="只写已完成、可检查的章节、实验、修改或投稿动作" /></label><label>文字证据（可选）<textarea name="evidence" rows={2} placeholder="章节页码、图表编号、评审记录；也可以只上传稿件附件" /></label></div>
      <div className="paper-form-section"><h3>3 · 下一行动</h3><label>下一项可交付行动<textarea name="nextAction" required rows={2} placeholder="例如：补充厚板数据消融实验并更新图 6" /></label><div className="form-row"><label>行动期限<input name="nextActionDueDate" type="date" min={minimumDate} required /></label><label>稿件编号 / DOI（投稿后可填）<input name="submissionIdentifier" placeholder="Manuscript ID、DOI 或送审编号" /></label></div><label>当前阻塞（可选）<textarea name="blocker" rows={2} placeholder="只写需要导师决策、资源或协作支持的问题；没有可留空" /></label></div>
      <input type="hidden" name="literatureRef" value="" /><input type="hidden" name="gitUrl" value="" />
      <label>稿件与证据附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>建议上传带版本号的稿件、回复信或关键图表；最多 5 个文件，单个不超过 20 MB</small></label>
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
      <label>项目附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件；单个不超过 20 MB，总计不超过 50 MB</small></label>
      {formError ? <p className="form-error">{formError}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "正在上传并提交…" : "提交项目进度"}</button></div>
    </form></div></div>;
  }

  return <div className="modal-layer" role="presentation"><div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="progress-dialog-title"><button className="close" aria-label="关闭提交进展对话框" onClick={onClose}>×</button><div className="modal-title"><span>新增进展记录</span><h2 id="progress-dialog-title">{paperProgress ? "论文推进到了哪一步？" : "这次工作产生了什么新信息？"}</h2><p>填写结论，并通过文字说明或附件提供可核验的证据。</p></div><form onSubmit={submit}><div className="form-row"><label>学生<select name="studentId" required defaultValue={students[0]?.id}>{students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.stage}</option>)}</select></label><label>进展类型<select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>{progressKinds.map((item) => <option key={item}>{item}</option>)}</select></label></div><label>进展标题<input name="title" required placeholder="例如：完成跨材料泛化验证" /></label><label>新增结论<textarea name="summary" required rows={3} placeholder="本次工作确认、排除或发现了什么？" /></label><label>文字证据（可选）<textarea name="evidence" rows={2} placeholder="实验编号、图表位置、评审记录；也可以只上传附件" /></label>{kind === "文献" ? <label>论文题目 / DOI<input name="literatureRef" required placeholder="至少提供可识别的论文题目或 DOI" /></label> : <input type="hidden" name="literatureRef" value="" />}<label>私有 GitHub 链接（可选）<input name="gitUrl" type="url" placeholder="只保存 HTTPS 链接；完整代码由本地 Agent 读取" /></label><label>进展附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件；单个不超过 20 MB，总计不超过 50 MB</small></label>{formError ? <p className="form-error">{formError}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "正在上传并提交…" : "提交给导师确认"}</button></div></form></div></div>;
}

function ProposalWorkspace({ viewer, students, onToast }: {
  viewer: DashboardData["viewer"];
  students: Student[];
  onToast: (message: string) => void;
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
        : items.find((item) => item.status === "submitted")?.id ?? items[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "研究方案加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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
          {proposals.map((proposal) => <button key={proposal.id} className={selectedId === proposal.id ? "selected" : ""} onClick={() => setSelectedId(proposal.id)}>
            <span className={`proposal-status ${proposal.status}`}>{proposalStatusMeta[proposal.status].label}</span>
            <strong>{proposal.student_name}</strong>
            <small>{proposal.title} · 第 {proposal.current_version || 0} 版</small>
          </button>)}
          {!proposals.length ? <div className="empty-small">管理员为负责学生建立研究方案后会显示在这里。</div> : null}
        </div>
      </div>
      <div>{selected ? <ProposalDetail proposal={selected} canReview={selected.can_review} onToast={onToast} onRefresh={load} /> : <div className="empty-state"><span>◇</span><strong>暂无研究方案</strong><small>由管理员为负责学生建立并代录研究方案。</small></div>}</div>
    </section> : null}
  </div>;
}

function ProposalEditor({ student, proposal, onCancel, onSaved }: {
  student: Student;
  proposal?: ResearchProposal;
  onCancel: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [milestones, setMilestones] = useState<Array<{ title: string; targetDate: string; evidenceTarget: string; status: MilestoneStatus }>>(
    proposal?.milestones.map((item) => ({ title: item.title, targetDate: item.target_date, evidenceTarget: item.evidence_target, status: item.status }))
      ?? [{ title: "", targetDate: "", evidenceTarget: "", status: "pending" }],
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
        <div className="milestone-editor-head"><div><strong>培养节点与验收证据</strong><small>节点采用通过/未通过管理，不混入普通进展分。</small></div><button type="button" onClick={() => setMilestones((current) => [...current, { title: "", targetDate: "", evidenceTarget: "", status: "pending" }])}>＋ 添加节点</button></div>
        {milestones.map((milestone, index) => <div className="milestone-edit-row" key={index}>
          <b>{index + 1}</b>
          <input aria-label={`第${index + 1}个节点名称`} value={milestone.title} onChange={(event) => updateMilestone(index, "title", event.target.value)} placeholder="如：完成开题论证" />
          <input aria-label={`第${index + 1}个节点日期`} type="date" value={milestone.targetDate} onChange={(event) => updateMilestone(index, "targetDate", event.target.value)} />
          <input aria-label={`第${index + 1}个节点证据`} value={milestone.evidenceTarget} onChange={(event) => updateMilestone(index, "evidenceTarget", event.target.value)} placeholder="验收材料或可核验证据" />
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
      <div className="milestone-timeline">{proposal.milestones.map((milestone, index) => <div className={`milestone-item ${milestone.status}`} key={milestone.id}><i>{index + 1}</i><div><strong>{milestone.title}</strong><small>目标日期：{milestone.target_date || "待补充"}</small><p>{milestone.evidence_target || "尚未填写验收证据"}</p></div>{proposal.status === "approved" ? <select aria-label={`${milestone.title}状态`} value={milestone.status} disabled={busy === `milestone-${milestone.id}`} onChange={(event) => void updateMilestone(milestone.id, event.target.value as MilestoneStatus)}>{Object.entries(milestoneStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <span>{milestoneStatusLabels[milestone.status]}</span>}</div>)}</div>
    </section>

    {canReview && (proposal.status === "submitted" || proposal.status === "approved") ? <section className="proposal-review-box"><label>{proposal.status === "submitted" ? "导师审核意见" : "重大调整说明"}<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder={proposal.status === "submitted" ? "退回修改时必须说明具体问题；确认时可记录验收意见" : "说明为什么需要重开方案并形成新版本"} /></label><div>{proposal.status === "submitted" ? <><button disabled={Boolean(busy)} onClick={() => void review("request_changes")}>退回修改</button><button className="primary" disabled={Boolean(busy)} onClick={() => void review("approve")}>确认并冻结</button></> : <button disabled={Boolean(busy)} onClick={() => void review("reopen")}>重开修订</button>}</div></section> : null}

    <div className="proposal-history-grid"><section><div className="section-title"><div><h3>版本历史</h3><p>每次正式提交生成不可覆盖的快照。</p></div></div><div className="history-list">{proposal.versions.map((version) => <div key={version.id}><b>V{version.version_number}</b><span>由 {version.submitted_by_name} 提交</span><small>{shortDate(version.created_at)}</small></div>)}{!proposal.versions.length ? <p>尚未正式提交版本。</p> : null}</div></section><section><div className="section-title"><div><h3>审计记录</h3><p>记录提交、审核和节点状态变化。</p></div></div><div className="audit-list">{proposal.audit.slice(0, 8).map((event) => <div key={event.id}><i /><span><strong>{auditLabels[event.action] || event.action}</strong><small>{event.actor_name} · {shortDate(event.created_at)}</small><p>{event.detail}</p></span></div>)}</div></section></div>
  </article>;
}

function FeishuModal({ viewer, onClose, onLogout }: { viewer: DashboardData["viewer"]; onClose: () => void; onLogout: () => Promise<void> }) {
  const roleLabel = viewer.role === "superadmin" ? "超级管理员" : viewer.role === "admin" ? "管理员（导师）" : "学生";
  return <div className="modal-layer" role="presentation"><div className="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="feishu-dialog-title"><button className="close" aria-label="关闭" onClick={onClose}>×</button><div className="modal-title"><span>飞书企业自建应用</span><h2 id="feishu-dialog-title">{viewer.name}，飞书身份已验证</h2><p>当前角色：{roleLabel}。系统权限由服务端校验。</p></div><div className="integration-list"><div><b>1</b><span><strong>飞书免登录</strong><small>由飞书工作台获取一次性授权码并建立安全会话</small></span><em className="done">已接入</em></div><div><b>2</b><span><strong>消息与卡片提醒</strong><small>按每名学生的 7/14/21/30 天周期发送</small></span><em>下一步</em></div><div><b>3</b><span><strong>智能纪要个人进展</strong><small>自动识别学生姓名并把科研部分拆成独立进展</small></span><em className="done">已接入</em></div></div><div className="safe-banner">普通聊天会在接收时立即过滤且不落库；纪要只能在学生归属明确时自动建个人进展，正式评价由对应主导师或超级管理员完成。</div><div className="modal-actions"><button type="button" onClick={() => void onLogout()}>退出飞书账号</button></div></div></div>;
}

function MeetingView({ viewer, students, onRemind }: { viewer: DashboardData["viewer"]; students: Student[]; onRemind: (student: Student) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [agendaOpen, setAgendaOpen] = useState(false);
  const due = students
    .map((student) => ({ student, remaining: student.cadenceDays - daysSinceLatestSubmission(student) }))
    .filter((item) => item.remaining <= 7)
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, 6);
  const agenda = [...students]
    .filter((student) => student.risk.level !== "正常" || student.cadenceDays - daysSinceLatestSubmission(student) <= 7)
    .sort((a, b) => b.risk.days - a.risk.days)
    .slice(0, 6);
  return <div className="meeting-workspace"><div className="meeting-grid"><section className="panel"><PanelHeader title="未来 7 天更新提醒" subtitle="按个人需要设置，最长不超过 30 天" count={due.length} /><div className="reminder-list">{due.map(({ student, remaining }) => <div key={student.id}><span>{remaining < 0 ? `逾期 ${Math.abs(remaining)} 天` : remaining === 0 ? "今天" : `${remaining} 天后`}</span><strong>{student.name}</strong><small>{student.cadenceDays} 天周期 · {student.stage}</small><button disabled={busy === student.id} onClick={async () => { setBusy(student.id); await onRemind(student); setBusy(null); }}>{busy === student.id ? "发送中…" : "飞书提醒"}</button></div>)}{!due.length ? <div className="empty-small">未来 7 天没有需要提醒的学生</div> : null}</div></section><section className="panel meeting-rule"><PanelHeader title="组会建议" subtitle="不是固定轮转，而是优先解决阻塞" /><div className="meeting-summary"><span>{agenda.length}</span><strong>名学生建议进入本周议程</strong><p>系统只根据连续无进展时间和个人更新周期排序，不自动评价学生。</p><button className="primary" onClick={() => setAgendaOpen((current) => !current)}>{agendaOpen ? "收起议程" : "生成本周议程"}</button>{agendaOpen ? <div className="agenda-list">{agenda.map((student, index) => <a key={student.id} href={`/students/${encodeURIComponent(student.id)}`}><b>{index + 1}</b><span><strong>{student.name}</strong><small>{student.risk.level !== "正常" ? `${student.risk.days} 天无实质性进展，优先确认阻塞与决策` : `进入 ${student.cadenceDays} 天更新窗口，核对本周期证据`}</small></span></a>)}{!agenda.length ? <p>本周暂无需要优先讨论的学生。</p> : null}</div> : null}</div></section></div><StaffMeetingRequests />{viewer.role === "superadmin" ? <FeishuMeetingImports students={students} /> : null}</div>;
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
          studentId: choices[item.id] || students[0]?.id,
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
      {item.status === "pending" ? <div className="meeting-import-actions"><select aria-label="关联学生" value={choices[item.id] || students[0]?.id || ""} onChange={(event) => setChoices((current) => ({ ...current, [item.id]: event.target.value }))}>{students.map((student) => <option value={student.id} key={student.id}>{student.name} · {student.stage}</option>)}</select><input aria-label="进展标题" value={titles[item.id] || ""} onChange={(event) => setTitles((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="无法自动拆分时的备用标题" /><button className="primary" disabled={busy === item.id || !students.length} onClick={() => void update(item, "create_progress")}>{busy === item.id ? "处理中…" : "人工归属此候选"}</button></div> : null}
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
    {viewer.role === "superadmin" ? <RosterImport students={students} onImported={onRosterImported} /> : null}
    {viewer.role === "superadmin" ? <StudentAccessSetup /> : null}
    <section className="panel setting-card"><PanelHeader title="飞书集成" subtitle="登录、提醒与 AI 会议总结导入" /><div className="setting-body"><span className="status-pill safe">智能拆分已启用</span><p>普通聊天即时过滤；智能纪要会按学生姓名和汇报分段生成个人进展，归属不明确时才进入备用人工区。</p><button className="primary" onClick={onFeishu}>查看接入状态</button></div></section>
    <section className="panel setting-card"><PanelHeader title="GitHub 私有仓库" subtitle="代码只能由本地模型读取" /><div className="setting-body"><span className="status-pill safe">本地读取</span><p>网站只保存仓库链接、提交号和学生主动提交的摘要，不把完整代码发送给云端 GPT。</p><button>稍后连接 GitHub App</button></div></section>
    <section className="panel setting-card"><PanelHeader title="开源流程参考" subtitle="TUM · Moodle · OSIRIS · eLabFTW" /><div className="setting-body"><span className="status-pill safe">模式已吸收</span><p>采用方案版本、角色权限、待办审核、成果台账与证据溯源等成熟模式；未复制第三方界面或业务代码。</p><div className="reference-links"><a href="https://github.com/ls1intum/thesis-management" target="_blank" rel="noreferrer">TUM</a><a href="https://github.com/moodle/moodle" target="_blank" rel="noreferrer">Moodle</a><a href="https://github.com/OSIRIS-Solutions/osiris" target="_blank" rel="noreferrer">OSIRIS</a><a href="https://github.com/elabftw/elabftw" target="_blank" rel="noreferrer">eLabFTW</a></div></div></section>
    <AccountManagement viewer={viewer} students={students} />
    <section className="panel setting-card"><PanelHeader title="AI 数据边界" subtitle="遵循已确认的 A / C / D 分类" /><div className="setting-body data-boundaries"><p><b>A</b>培养计划、进展记录、论文草稿可交给云端模型</p><p><b>C</b>代码仓库、专利及保密项目仅限本地模型</p><p><b>D</b>私人评价、身心健康、正式成绩不允许 AI 读取</p></div></section>
  </div>;
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
  email: string;
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
        <div className="account-person"><div className="mini-avatar">{user.display_name.slice(0, 1)}</div><span><strong>{user.display_name}</strong><small>{user.email || "飞书成员"}</small></span></div>
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
      .then((response) => response.json())
      .then((value: { configured: boolean; appId: string; sdkUrl: string }) => {
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
  return <main className="access-shell"><section className="access-card"><div className="access-brand"><div className="brand-mark">探</div><div><strong>探研</strong><span>射线探伤 × AI</span></div></div><div className={`access-orb ${pending ? "pending" : ""}`}>{pending ? "✓" : "飞"}</div><p className="access-kicker">飞书企业自建应用</p><h1>{pending ? "飞书身份已验证" : setup ? "飞书接入等待应用配置" : "正在通过飞书安全登录"}</h1><p className="access-copy">{pending ? "当前账号已经完成飞书登录，现在只差系统角色授权，无需反复点击飞书授权。" : message}</p>{pending ? <><div className="access-pending-note"><strong>下一步由超级管理员处理</strong><span>请在“系统设置 → 飞书账号与高权限授权”中，为当前账号分配学生或导师角色。</span></div><div className="access-actions"><button className="primary" disabled={status === "checking" || status === "authorizing"} onClick={() => void checkAccess()}>{status === "checking" ? "检查中…" : "重新检查权限"}</button><button disabled={status === "authorizing"} onClick={() => void switchAccount()}>{status === "authorizing" ? "切换中…" : "切换飞书账号"}</button></div></> : null}{setup ? <div className="setup-steps"><span><b>1</b>创建企业自建应用并添加“网页应用”能力</span><span><b>2</b>将应用主页设为当前系统地址</span><span><b>3</b>安全配置 App ID 和 App Secret 后发布</span></div> : null}{!pending && (status === "authorizing" || status === "checking") ? <div className="access-loading"><i /><span>正在确认飞书环境…</span></div> : null}{!pending && status === "error" && config?.configured ? <button className="primary access-retry" onClick={() => void authorize(config)}>重新尝试飞书登录</button> : null}<div className="access-safe">不会把 App Secret、飞书访问凭证或完整代码发送给云端 GPT</div></section></main>;
}

function LoadingState() {
  return <div className="loading-grid"><div /><div /><div /><div /><section /><aside /></div>;
}
