"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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
  risk: { level: RiskLevel; days: number };
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
  milestones: ProposalMilestone[];
  versions: Array<{ id: number; version_number: number; created_at: string; submitted_by_name: string }>;
  audit: Array<{ id: number; action: string; detail: string; created_at: string; actor_name: string }>;
};

type DashboardData = {
  viewer: {
    name: string;
    avatarUrl: string;
    role: "admin" | "student";
    studentId: string | null;
  };
  students: Student[];
  pending: PendingEntry[];
  metrics: {
    total: number;
    doctors: number;
    masters: number;
    pending: number;
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

const progressKinds = ["文献", "实验", "算法", "数据", "论文", "复现", "项目"];

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

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<(typeof navItems)[number]["id"]>("overview");
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"全部" | RiskLevel>("全部");
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState<number | null>(null);
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
        setAuthGate({ kind: "pending", message: payload.error || "账号等待导师分配角色" });
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
      .filter((student) =>
        !normalized || `${student.name}${student.stage}${student.currentFocus}${student.degree}`.toLowerCase().includes(normalized),
      )
      .sort((a, b) => b.risk.days - a.risk.days);
  }, [data, query, riskFilter]);

  async function review(entry: PendingEntry, action: string) {
    setReviewBusy(entry.id);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, action }),
      });
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "审核失败");
      setToast(action === "substantive" ? "已确认为实质性进展" : "审核结果已保存");
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
    return <FeishuAccessGate gate={authGate} onAuthenticated={loadDashboard} />;
  }

  const visibleNavItems = data?.viewer.role === "student"
    ? navItems.filter((item) => ["overview", "students", "proposals", "meetings"].includes(item.id))
    : navItems;

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
          <div><strong>{data?.viewer.name || "佘阳"}</strong><span>{data?.viewer.role === "student" ? "学生" : "管理员"}</span></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{today}</p>
            <h1>{view === "overview" ? "科研进展驾驶舱" : navItems.find((item) => item.id === view)?.label}</h1>
            <p className="subtitle">
              {view === "overview" ? "只关注新增证据、研究结论和需要您决策的事项。" : view === "proposals" ? "学生主写、导师确认，每次修订均保留版本与审核记录。" : "以阶段内是否产生可验证的新信息为核心。"}
            </p>
          </div>
          <div className="top-actions">
            <button className="feishu connected" onClick={() => setFeishuOpen(true)}><i />飞书已登录</button>
            <button className="primary" onClick={() => setSubmitOpen(true)}>＋ 提交进展</button>
          </div>
        </header>

        {loading ? <LoadingState /> : null}
        {error ? <div className="error-state"><strong>数据暂时未加载</strong><span>{error}</span><button onClick={() => void loadDashboard()}>重试</button></div> : null}

        {!loading && !error && data && view === "overview" ? (
          <>
            <section className="metric-grid" aria-label="课题组概况">
              <article className="metric"><span>在组学生</span><strong>{data.metrics.total}</strong><small>{data.metrics.doctors} 博士 · {data.metrics.masters} 硕士</small></article>
              <article className="metric"><span>当前无需预警</span><strong>{data.metrics.total - data.metrics.attention}</strong><small className="positive">首次导入从纳入管理日期计时</small></article>
              <article className="metric"><span>等待您确认</span><strong>{data.metrics.pending}</strong><small>可在右侧快速审核</small></article>
              <article className="metric attention"><span>需要关注</span><strong>{data.metrics.attention}</strong><small>黄 {data.metrics.riskCounts.黄色 ?? 0} · 橙 {data.metrics.riskCounts.橙色 ?? 0} · 红 {data.metrics.riskCounts.红色 ?? 0}</small></article>
            </section>

            <div className="content-grid">
              <section className="panel student-panel">
                <PanelHeader title="学生进展" subtitle="按距离上次实质性进展的时间排序" action={`查看全部 ${data.metrics.total} 人 →`} onAction={() => setView("students")} />
                <StudentFilters query={query} setQuery={setQuery} riskFilter={riskFilter} setRiskFilter={setRiskFilter} />
                <StudentTable students={filteredStudents.slice(0, 8)} onSelect={setSelectedStudent} />
              </section>

              <aside className="right-column">
                <section className="panel decisions">
                  <PanelHeader title="待您确认" subtitle="四类判断，不进行综合打分" count={data.metrics.pending} />
                  {data.pending.slice(0, 3).map((entry) => (
                    <button className="decision-card" key={entry.id} onClick={() => setView("reviews")}>
                      <span className={`decision-icon kind-${entry.kind}`}>{entry.kind.slice(0, 1)}</span>
                      <div><strong>{entry.display_name} · {entry.kind}</strong><small>{entry.title}</small></div><b>›</b>
                    </button>
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
            <StudentFilters query={query} setQuery={setQuery} riskFilter={riskFilter} setRiskFilter={setRiskFilter} />
            <StudentTable students={filteredStudents} onSelect={setSelectedStudent} />
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
                  <div><h2>{entry.title}</h2><p>{entry.display_name} · {entry.kind} · {shortDate(entry.submitted_at)}提交</p></div>
                </div>
                <div className="review-evidence">
                  <div><span>新增结论</span><p>{entry.summary}</p></div>
                  <div><span>证据</span><p>{entry.evidence}</p></div>
                  {entry.literature_ref ? <div><span>论文 / DOI</span><p>{entry.literature_ref}</p></div> : null}
                </div>
                <div className="review-actions" aria-label="进展判断">
                  <button disabled={reviewBusy === entry.id} className="approve" onClick={() => void review(entry, "substantive")}>实质性进展</button>
                  <button disabled={reviewBusy === entry.id} onClick={() => void review(entry, "supporting")}>支持性工作</button>
                  <button disabled={reviewBusy === entry.id} onClick={() => void review(entry, "supplement")}>需要补充</button>
                  <button disabled={reviewBusy === entry.id} onClick={() => void review(entry, "rejected")}>非进展</button>
                </div>
              </article>
            ))}
            {!data.pending.length ? <div className="empty-state"><span>✓</span><strong>待审核记录已清空</strong><small>新的飞书提交会自动进入这里。</small></div> : null}
          </section>
        ) : null}

        {!loading && !error && view === "meetings" ? <MeetingView students={data?.students ?? []} onRemind={sendReminder} /> : null}
        {!loading && !error && view === "settings" && data ? <SettingsView onFeishu={() => setFeishuOpen(true)} students={data.students} onRosterImported={async () => { setToast("真实学生名册已导入"); await loadDashboard(); }} /> : null}
      </section>

      {selectedStudent ? <StudentDrawer student={selectedStudent} onClose={() => setSelectedStudent(null)} /> : null}
      {submitOpen && data ? <ProgressModal students={data.students} onClose={() => setSubmitOpen(false)} onSaved={async () => { setSubmitOpen(false); setToast("进展已提交，等待导师确认"); await loadDashboard(); }} /> : null}
      {feishuOpen && data ? <FeishuModal viewer={data.viewer} onClose={() => setFeishuOpen(false)} onLogout={async () => { await fetch("/api/auth/logout", { method: "POST" }); window.location.reload(); }} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );
}

function PanelHeader({ title, subtitle, action, onAction, count }: { title: string; subtitle: string; action?: string; onAction?: () => void; count?: number }) {
  return <div className="panel-head"><div><h2>{title}</h2><p>{subtitle}</p></div>{action ? <button className="text-button" onClick={onAction}>{action}</button> : count !== undefined ? <span className="count">{count}</span> : null}</div>;
}

function StudentFilters({ query, setQuery, riskFilter, setRiskFilter }: {
  query: string;
  setQuery: (value: string) => void;
  riskFilter: "全部" | RiskLevel;
  setRiskFilter: (value: "全部" | RiskLevel) => void;
}) {
  return <div className="filter-bar"><label><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索学生、阶段或研究方向" /></label><div className="filter-chips">{(["全部", "正常", "黄色", "橙色", "红色"] as const).map((risk) => <button className={riskFilter === risk ? "selected" : ""} key={risk} onClick={() => setRiskFilter(risk)}>{risk}</button>)}</div></div>;
}

function StudentTable({ students, onSelect }: { students: Student[]; onSelect: (student: Student) => void }) {
  return <div className="student-table"><div className="table-row table-head"><span>学生</span><span>当前阶段</span><span>最近实质性进展</span><span>状态</span></div>{students.map((student) => <button className="table-row student-row" key={student.id} onClick={() => onSelect(student)}><div className="student-name"><div className="mini-avatar">{student.name.slice(-2)}</div><div><strong>{student.name}</strong><small>{student.gradeYear}级{student.degree} · {student.cadenceDays}天更新</small></div></div><div><span className="stage-tag">{student.stage}</span></div><div className="progress-copy"><strong>{student.latestTitle}</strong><small><em>{student.latestKind}</em>{sinceText(student.risk.days)}</small></div><div><span className={`risk ${student.risk.level}`}>{student.risk.level}</span></div></button>)}{!students.length ? <div className="empty-small">没有符合条件的学生</div> : null}</div>;
}

function StudentDrawer({ student, onClose }: { student: Student; onClose: () => void }) {
  return <div className="overlay" role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Escape" || event.key === "Enter") onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer"><button className="close" onClick={onClose}>×</button><div className="drawer-profile"><div className="large-avatar">{student.name.slice(-2)}</div><h2>{student.name}</h2><p>{student.gradeYear}级{student.degree}</p><span className={`risk ${student.risk.level}`}>{student.risk.level}</span></div><div className="detail-grid"><div><span>当前阶段</span><strong>{student.stage}</strong></div><div><span>更新周期</span><strong>{student.cadenceDays} 天</strong></div><div className="wide"><span>当前研究重点</span><strong>{student.currentFocus}</strong></div><div className="wide"><span>最近实质性进展</span><strong>{student.latestTitle}</strong><small>{shortDate(student.lastSubstantiveAt)} · {sinceText(student.risk.days)}</small></div></div><div className="drawer-note"><strong>系统建议</strong><p>{student.risk.level === "正常" ? "当前无需导师介入，等待下一次个性化更新。" : `已连续 ${student.risk.days} 天没有确认的实质性进展，建议检查阻塞项并给出下一步决策。`}</p></div></aside></div>;
}

function ProgressModal({ students, onClose, onSaved }: { students: Student[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [kind, setKind] = useState("文献");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const response = await fetch("/api/progress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "提交失败");
      await onSaved();
    } catch (submitError) { setFormError(submitError instanceof Error ? submitError.message : "提交失败"); setBusy(false); }
  }
  return <div className="modal-layer"><div className="modal"><button className="close" onClick={onClose}>×</button><div className="modal-title"><span>新增进展记录</span><h2>这次工作产生了什么新信息？</h2><p>不按工作量打分，只记录结论与可核验的证据。</p></div><form onSubmit={submit}><div className="form-row"><label>学生<select name="studentId" required defaultValue={students[0]?.id}>{students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.stage}</option>)}</select></label><label>进展类型<select name="kind" value={kind} onChange={(event) => setKind(event.target.value)}>{progressKinds.map((item) => <option key={item}>{item}</option>)}</select></label></div><label>进展标题<input name="title" required placeholder="例如：完成跨材料泛化验证" /></label><label>新增结论<textarea name="summary" required rows={3} placeholder="本次工作确认、排除或发现了什么？" /></label><label>证据<textarea name="evidence" required rows={2} placeholder="实验编号、图表、记录位置或 Git 提交号" /></label>{kind === "文献" ? <label>论文题目 / DOI<input name="literatureRef" required placeholder="至少提供可识别的论文题目或 DOI" /></label> : <input type="hidden" name="literatureRef" value="" />}<label>私有 GitHub 链接（可选）<input name="gitUrl" placeholder="只保存链接；完整代码由本地 Agent 读取" /></label>{formError ? <p className="form-error">{formError}</p> : null}<div className="modal-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "提交中…" : "提交给导师确认"}</button></div></form></div></div>;
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

  const ownProposal = viewer.studentId ? proposals.find((item) => item.student_id === viewer.studentId) : undefined;
  const ownStudent = viewer.studentId ? students.find((item) => item.id === viewer.studentId) : undefined;
  const selected = proposals.find((item) => item.id === selectedId);
  const showEditor = Boolean(ownStudent && (editing || (viewer.role === "student" && !ownProposal)));
  const editable = !ownProposal || ownProposal.status === "draft" || ownProposal.status === "changes_requested";

  if (loading) return <div className="proposal-loading">正在读取研究方案与版本记录…</div>;
  if (error) return <div className="error-state"><strong>研究方案暂时未加载</strong><span>{error}</span><button onClick={() => void load()}>重试</button></div>;

  return <div className="proposal-workspace">
    <section className="proposal-principle">
      <div><span>TUM 流程借鉴</span><h2>学生主写，导师确认，方案与执行证据保持可追溯</h2><p>AI 可以检查结构、遗漏和风险，但不能代写最终方案，也不能替代导师作出正式评价。</p></div>
      <div className="proposal-flow"><b>草稿</b><i>→</i><b>提交</b><i>→</i><b>批注修订</b><i>→</i><b>确认冻结</b></div>
    </section>

    {viewer.studentId && ownStudent ? <section className="panel own-proposal-card">
      <PanelHeader title="我的研究方案" subtitle={`${ownStudent.name} · ${ownStudent.gradeYear}级${ownStudent.degree}`} />
      <div className="own-proposal-body">
        <div>
          <span className={`proposal-status ${ownProposal?.status ?? "draft"}`}>{proposalStatusMeta[ownProposal?.status ?? "draft"].label}</span>
          <strong>{ownProposal?.title || "尚未建立研究方案"}</strong>
          <small>{ownProposal ? `${proposalStatusMeta[ownProposal.status].hint} · 当前第 ${ownProposal.current_version || 0} 版` : "从科学问题、技术路线和培养节点开始撰写"}</small>
        </div>
        {editable ? <button className="primary" onClick={() => setEditing(true)}>{ownProposal ? "继续编辑" : "开始撰写"}</button> : null}
      </div>
      {ownProposal?.status === "changes_requested" && ownProposal.reviewer_note ? <div className="proposal-review-note"><b>导师修改意见</b><p>{ownProposal.reviewer_note}</p></div> : null}
    </section> : null}

    {showEditor && ownStudent ? <ProposalEditor
      student={ownStudent}
      proposal={ownProposal}
      onCancel={() => setEditing(false)}
      onSaved={async (message) => { onToast(message); setEditing(false); await load(); }}
    /> : null}

    {viewer.role === "student" && ownProposal && !showEditor ? <ProposalDetail
      proposal={ownProposal}
      canReview={false}
      onToast={onToast}
      onRefresh={load}
    /> : null}

    {viewer.role === "admin" ? <section className="proposal-admin-layout">
      <div className="panel proposal-list-panel">
        <PanelHeader title="全部研究方案" subtitle="优先显示待审核与待修改方案" count={proposals.length} />
        <div className="proposal-list">
          {proposals.map((proposal) => <button key={proposal.id} className={selectedId === proposal.id ? "selected" : ""} onClick={() => setSelectedId(proposal.id)}>
            <span className={`proposal-status ${proposal.status}`}>{proposalStatusMeta[proposal.status].label}</span>
            <strong>{proposal.student_name}</strong>
            <small>{proposal.title} · 第 {proposal.current_version || 0} 版</small>
          </button>)}
          {!proposals.length ? <div className="empty-small">学生提交研究方案后会显示在这里。</div> : null}
        </div>
      </div>
      <div>{selected ? <ProposalDetail proposal={selected} canReview onToast={onToast} onRefresh={load} /> : <div className="empty-state"><span>◇</span><strong>暂无研究方案</strong><small>学生可以在自己的飞书账号中开始撰写。</small></div>}</div>
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

    <section className="proposal-milestones"><div className="section-title"><div><h3>培养节点</h3><p>方案确认后，学生和管理员可以更新执行状态；完成必须另有证据记录。</p></div><b>{proposal.milestones.filter((item) => item.status === "completed").length}/{proposal.milestones.length}</b></div>
      <div className="milestone-timeline">{proposal.milestones.map((milestone, index) => <div className={`milestone-item ${milestone.status}`} key={milestone.id}><i>{index + 1}</i><div><strong>{milestone.title}</strong><small>目标日期：{milestone.target_date || "待补充"}</small><p>{milestone.evidence_target || "尚未填写验收证据"}</p></div>{proposal.status === "approved" ? <select aria-label={`${milestone.title}状态`} value={milestone.status} disabled={busy === `milestone-${milestone.id}`} onChange={(event) => void updateMilestone(milestone.id, event.target.value as MilestoneStatus)}>{Object.entries(milestoneStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <span>{milestoneStatusLabels[milestone.status]}</span>}</div>)}</div>
    </section>

    {canReview && (proposal.status === "submitted" || proposal.status === "approved") ? <section className="proposal-review-box"><label>{proposal.status === "submitted" ? "导师审核意见" : "重大调整说明"}<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder={proposal.status === "submitted" ? "退回修改时必须说明具体问题；确认时可记录验收意见" : "说明为什么需要重开方案并形成新版本"} /></label><div>{proposal.status === "submitted" ? <><button disabled={Boolean(busy)} onClick={() => void review("request_changes")}>退回修改</button><button className="primary" disabled={Boolean(busy)} onClick={() => void review("approve")}>确认并冻结</button></> : <button disabled={Boolean(busy)} onClick={() => void review("reopen")}>重开修订</button>}</div></section> : null}

    <div className="proposal-history-grid"><section><div className="section-title"><div><h3>版本历史</h3><p>每次正式提交生成不可覆盖的快照。</p></div></div><div className="history-list">{proposal.versions.map((version) => <div key={version.id}><b>V{version.version_number}</b><span>由 {version.submitted_by_name} 提交</span><small>{shortDate(version.created_at)}</small></div>)}{!proposal.versions.length ? <p>尚未正式提交版本。</p> : null}</div></section><section><div className="section-title"><div><h3>审计记录</h3><p>记录提交、审核和节点状态变化。</p></div></div><div className="audit-list">{proposal.audit.slice(0, 8).map((event) => <div key={event.id}><i /><span><strong>{auditLabels[event.action] || event.action}</strong><small>{event.actor_name} · {shortDate(event.created_at)}</small><p>{event.detail}</p></span></div>)}</div></section></div>
  </article>;
}

function FeishuModal({ viewer, onClose, onLogout }: { viewer: DashboardData["viewer"]; onClose: () => void; onLogout: () => Promise<void> }) {
  return <div className="modal-layer"><div className="modal compact-modal"><button className="close" onClick={onClose}>×</button><div className="modal-title"><span>飞书企业自建应用</span><h2>{viewer.name}，飞书身份已验证</h2><p>当前角色：{viewer.role === "admin" ? "管理员" : "学生"}。系统权限由服务端校验。</p></div><div className="integration-list"><div><b>1</b><span><strong>飞书免登录</strong><small>由飞书工作台获取一次性授权码并建立安全会话</small></span><em className="done">已接入</em></div><div><b>2</b><span><strong>消息与卡片提醒</strong><small>按每名学生的 7/14/21/30 天周期发送</small></span><em>下一步</em></div><div><b>3</b><span><strong>历史记录导入</strong><small>仅导入您明确授权的群聊或文档</small></span><em>待授权</em></div></div><div className="safe-banner">App Secret 只保存在加密环境变量中；系统不保存飞书 user_access_token。</div><div className="modal-actions"><button type="button" onClick={() => void onLogout()}>退出飞书账号</button></div></div></div>;
}

function MeetingView({ students, onRemind }: { students: Student[]; onRemind: (student: Student) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const due = students.filter((student) => student.risk.days + 7 >= student.cadenceDays).slice(0, 6);
  return <div className="meeting-grid"><section className="panel"><PanelHeader title="未来 7 天更新提醒" subtitle="按个人需要设置，最长不超过 30 天" count={due.length} /><div className="reminder-list">{due.map((student, index) => <div key={student.id}><span>{index < 2 ? "明天" : index < 4 ? "3 天后" : "本周内"}</span><strong>{student.name}</strong><small>{student.cadenceDays} 天周期 · {student.stage}</small><button disabled={busy === student.id} onClick={async () => { setBusy(student.id); await onRemind(student); setBusy(null); }}>{busy === student.id ? "发送中…" : "飞书提醒"}</button></div>)}</div></section><section className="panel meeting-rule"><PanelHeader title="组会建议" subtitle="不是固定轮转，而是优先解决阻塞" /><div className="meeting-summary"><span>{students.filter((student) => student.risk.level !== "正常").length}</span><strong>名学生需要优先讨论</strong><p>系统会根据连续无进展时间、待决策事项和证据缺口自动生成组会议程草案。</p><button className="primary">生成本周议程</button></div></section></div>;
}

function SettingsView({ onFeishu, students, onRosterImported }: { onFeishu: () => void; students: Student[]; onRosterImported: () => Promise<void> }) {
  return <div className="settings-grid"><RosterImport students={students} onImported={onRosterImported} /><section className="panel setting-card"><PanelHeader title="飞书集成" subtitle="登录、消息、历史记录导入" /><div className="setting-body"><span className="status-pill safe">飞书身份已验证</span><p>登录和角色校验均在服务端完成；机器人提醒将在学生绑定飞书账号后可用。</p><button className="primary" onClick={onFeishu}>查看接入状态</button></div></section><section className="panel setting-card"><PanelHeader title="GitHub 私有仓库" subtitle="代码只能由本地模型读取" /><div className="setting-body"><span className="status-pill safe">本地读取</span><p>网站只保存仓库链接、提交号和学生主动提交的摘要，不把完整代码发送给云端 GPT。</p><button>稍后连接 GitHub App</button></div></section><section className="panel setting-card"><PanelHeader title="TUM 论文流程参考" subtitle="MIT 开源许可 · 本系统保持独立技术架构" /><div className="setting-body"><span className="status-pill safe">流程已移植</span><p>借鉴研究方案提交、版本历史、导师退回与确认、权限矩阵和审计留痕；飞书身份及科研证据评价仍由本系统负责。</p><a className="setting-link" href="https://github.com/ls1intum/thesis-management" target="_blank" rel="noreferrer">查看原项目与许可证</a></div></section><AccountManagement students={students} /><section className="panel setting-card"><PanelHeader title="AI 数据边界" subtitle="遵循已确认的 A / C / D 分类" /><div className="setting-body data-boundaries"><p><b>A</b>培养计划、进展记录、论文草稿可交给云端模型</p><p><b>C</b>代码仓库、专利及保密项目仅限本地模型</p><p><b>D</b>私人评价、身心健康、正式成绩不允许 AI 读取</p></div></section></div>;
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

  return <section className="panel setting-card"><PanelHeader title="真实学生名册" subtitle="仅管理员可以执行导入" /><div className="setting-body"><span className="status-pill safe">{imported ? "已导入 26 人" : "等待导入"}</span><p>{imported ? "12 名博士生、14 名硕士生已纳入管理；演示记录已停用归档。" : "导入已确认的 26 人名册，并保留现有演示数据作为停用归档。"}</p><button className="primary" disabled={busy || imported} onClick={() => void importRoster()}>{busy ? "正在导入…" : imported ? "名册已导入" : "导入已确认名册"}</button>{message ? <small>{message}</small> : null}</div></section>;
}

type ManagedUser = {
  id: number;
  display_name: string;
  avatar_url: string;
  email: string;
  role: "admin" | "student" | "pending";
  student_id: string | null;
  student_name: string | null;
  last_login_at: string;
};

function AccountManagement({ students }: { students: Student[] }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/users", { cache: "no-store" });
    const payload = (await response.json()) as { users?: ManagedUser[]; error?: string };
    if (!response.ok) throw new Error(payload.error || "账号列表加载失败");
    setUsers(payload.users ?? []);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadUsers().catch((error: Error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [loadUsers]);

  async function updateUser(user: ManagedUser, role: "student" | "pending") {
    setBusy(user.id); setMessage("");
    try {
      const response = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, role, studentId: role === "student" ? choices[user.id] || students[0]?.id : null }),
      });
      const payload = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "账号更新失败");
      setMessage(payload.message || "账号已更新");
      await loadUsers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号更新失败");
    } finally { setBusy(null); }
  }

  return <section className="panel account-panel"><PanelHeader title="飞书账号与学生绑定" subtitle="新用户先进入等待状态，由您确认后才能访问数据" count={users.length} /><div className="account-list">{users.map((user) => <div className="account-row" key={user.id}><div className="account-person"><div className="mini-avatar">{user.display_name.slice(0, 1)}</div><span><strong>{user.display_name}</strong><small>{user.email || "飞书成员"}</small></span></div>{user.role === "admin" ? <><span className="status-pill safe">管理员</span>{user.student_name ? <span className="bound-student">本人学生记录：{user.student_name}</span> : null}</> : user.role === "student" ? <><span className="bound-student">已绑定：{user.student_name}</span><button disabled={busy === user.id} onClick={() => void updateUser(user, "pending")}>解除</button></> : <><select value={choices[user.id] || students[0]?.id || ""} onChange={(event) => setChoices((current) => ({ ...current, [user.id]: event.target.value }))}>{students.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.stage}</option>)}</select><button className="bind" disabled={busy === user.id} onClick={() => void updateUser(user, "student")}>{busy === user.id ? "绑定中…" : "确认绑定"}</button></>}</div>)}{!users.length ? <div className="empty-small">学生第一次从飞书打开应用后，账号会出现在这里。</div> : null}</div>{message ? <div className="account-message">{message}</div> : null}</section>;
}

function FeishuAccessGate({ gate, onAuthenticated }: { gate: AuthGate; onAuthenticated: () => Promise<void> }) {
  const [status, setStatus] = useState<"checking" | "ready" | "authorizing" | "error">("checking");
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
  }, [authorize]);

  const pending = gate.kind === "pending";
  const setup = gate.kind === "setup" || config?.configured === false;
  return <main className="access-shell"><section className="access-card"><div className="access-brand"><div className="brand-mark">探</div><div><strong>探研</strong><span>射线探伤 × AI</span></div></div><div className={`access-orb ${pending ? "pending" : ""}`}>{pending ? "…" : "飞"}</div><p className="access-kicker">飞书企业自建应用</p><h1>{pending ? "身份已验证，等待分配角色" : setup ? "飞书接入等待应用配置" : "正在通过飞书安全登录"}</h1><p className="access-copy">{message}</p>{setup ? <div className="setup-steps"><span><b>1</b>创建企业自建应用并添加“网页应用”能力</span><span><b>2</b>将应用主页设为当前系统地址</span><span><b>3</b>安全配置 App ID 和 App Secret 后发布</span></div> : null}{status === "authorizing" || status === "checking" ? <div className="access-loading"><i /><span>正在确认飞书环境…</span></div> : null}{status === "error" && config?.configured ? <button className="primary access-retry" onClick={() => void authorize(config)}>重新尝试飞书登录</button> : null}<div className="access-safe">不会把 App Secret、飞书访问凭证或完整代码发送给云端 GPT</div></section></main>;
}

function LoadingState() {
  return <div className="loading-grid"><div /><div /><div /><div /><section /><aside /></div>;
}
