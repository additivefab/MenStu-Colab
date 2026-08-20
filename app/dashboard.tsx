"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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

type DashboardData = {
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

const navItems = [
  { id: "overview", label: "总览", icon: "▦" },
  { id: "students", label: "学生", icon: "◎" },
  { id: "reviews", label: "进展审核", icon: "✓" },
  { id: "meetings", label: "组会与提醒", icon: "▣" },
  { id: "settings", label: "系统设置", icon: "⚙" },
] as const;

const progressKinds = ["文献", "实验", "算法", "数据", "论文", "复现", "项目"];

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

  const loadDashboard = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      const payload = (await response.json()) as DashboardData & { error?: string };
      if (!response.ok) throw new Error(payload.error || "加载失败");
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

  const today = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date());

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">探</div>
          <div><strong>探研</strong><span>射线探伤 × AI</span></div>
        </div>
        <nav aria-label="主导航">
          {navItems.map((item) => (
            <button className={`nav-item ${view === item.id ? "active" : ""}`} key={item.id} onClick={() => setView(item.id)}>
              <span>{item.icon}</span>{item.label}
              {item.id === "reviews" && data?.metrics.pending ? <b>{data.metrics.pending}</b> : null}
            </button>
          ))}
        </nav>
        <div className="privacy-note"><span>AI 数据边界已启用</span><small>代码与保密项目仅限本地模型</small></div>
        <div className="sidebar-foot">
          <div className="avatar">导</div>
          <div><strong>主导师</strong><span>管理员 · 最终确认人</span></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{today}</p>
            <h1>{view === "overview" ? "科研进展驾驶舱" : navItems.find((item) => item.id === view)?.label}</h1>
            <p className="subtitle">
              {view === "overview" ? "只关注新增证据、研究结论和需要您决策的事项。" : "以阶段内是否产生可验证的新信息为核心。"}
            </p>
          </div>
          <div className="top-actions">
            <button className="feishu" onClick={() => setFeishuOpen(true)}><i />飞书接入待配置</button>
            <button className="primary" onClick={() => setSubmitOpen(true)}>＋ 提交进展</button>
          </div>
        </header>

        {loading ? <LoadingState /> : null}
        {error ? <div className="error-state"><strong>数据暂时未加载</strong><span>{error}</span><button onClick={() => void loadDashboard()}>重试</button></div> : null}

        {!loading && !error && data && view === "overview" ? (
          <>
            <section className="metric-grid" aria-label="课题组概况">
              <article className="metric"><span>在组学生</span><strong>{data.metrics.total}</strong><small>{data.metrics.doctors} 博士 · {data.metrics.masters} 硕士</small></article>
              <article className="metric"><span>30 天内有实质进展</span><strong>{data.metrics.total - data.metrics.attention}</strong><small className="positive">以导师确认后的证据为准</small></article>
              <article className="metric"><span>等待您确认</span><strong>{data.metrics.pending}</strong><small>可在右侧快速审核</small></article>
              <article className="metric attention"><span>需要关注</span><strong>{data.metrics.attention}</strong><small>黄 {data.metrics.riskCounts.黄色 ?? 0} · 橙 {data.metrics.riskCounts.橙色 ?? 0} · 红 {data.metrics.riskCounts.红色 ?? 0}</small></article>
            </section>

            <div className="content-grid">
              <section className="panel student-panel">
                <PanelHeader title="学生进展" subtitle="按距离上次实质性进展的时间排序" action="查看全部 25 人 →" onAction={() => setView("students")} />
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

        {!loading && !error && view === "meetings" ? <MeetingView students={data?.students ?? []} /> : null}
        {!loading && !error && view === "settings" ? <SettingsView onFeishu={() => setFeishuOpen(true)} /> : null}
      </section>

      {selectedStudent ? <StudentDrawer student={selectedStudent} onClose={() => setSelectedStudent(null)} /> : null}
      {submitOpen && data ? <ProgressModal students={data.students} onClose={() => setSubmitOpen(false)} onSaved={async () => { setSubmitOpen(false); setToast("进展已提交，等待导师确认"); await loadDashboard(); }} /> : null}
      {feishuOpen ? <FeishuModal onClose={() => setFeishuOpen(false)} /> : null}
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

function FeishuModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-layer"><div className="modal compact-modal"><button className="close" onClick={onClose}>×</button><div className="modal-title"><span>飞书企业自建应用</span><h2>界面已预留，凭据尚未配置</h2><p>网站将作为飞书工作台应用打开，机器人负责提醒与快捷提交。</p></div><div className="integration-list"><div><b>1</b><span><strong>登录与身份映射</strong><small>需要飞书 App ID、App Secret 和重定向域名</small></span><em>待配置</em></div><div><b>2</b><span><strong>消息与卡片提醒</strong><small>按每名学生的 7/14/21/30 天周期发送</small></span><em>待配置</em></div><div><b>3</b><span><strong>历史记录导入</strong><small>经授权后拉取指定群聊或文档，不读取私人评价</small></span><em>待授权</em></div></div><div className="safe-banner">真实密钥不会写入代码仓库；部署时通过加密环境变量配置。</div></div></div>;
}

function MeetingView({ students }: { students: Student[] }) {
  const due = students.filter((student) => student.risk.days + 7 >= student.cadenceDays).slice(0, 6);
  return <div className="meeting-grid"><section className="panel"><PanelHeader title="未来 7 天更新提醒" subtitle="按个人需要设置，最长不超过 30 天" count={due.length} /><div className="reminder-list">{due.map((student, index) => <div key={student.id}><span>{index < 2 ? "明天" : index < 4 ? "3 天后" : "本周内"}</span><strong>{student.name}</strong><small>{student.cadenceDays} 天周期 · {student.stage}</small><button>飞书提醒</button></div>)}</div></section><section className="panel meeting-rule"><PanelHeader title="组会建议" subtitle="不是固定轮转，而是优先解决阻塞" /><div className="meeting-summary"><span>{students.filter((student) => student.risk.level !== "正常").length}</span><strong>名学生需要优先讨论</strong><p>系统会根据连续无进展时间、待决策事项和证据缺口自动生成组会议程草案。</p><button className="primary">生成本周议程</button></div></section></div>;
}

function SettingsView({ onFeishu }: { onFeishu: () => void }) {
  return <div className="settings-grid"><section className="panel setting-card"><PanelHeader title="飞书集成" subtitle="登录、消息、历史记录导入" /><div className="setting-body"><span className="status-pill pending">待配置凭据</span><p>创建飞书企业自建应用后，将 App ID、Secret 与事件回调信息配置到部署环境。</p><button className="primary" onClick={onFeishu}>查看接入清单</button></div></section><section className="panel setting-card"><PanelHeader title="GitHub 私有仓库" subtitle="代码只能由本地模型读取" /><div className="setting-body"><span className="status-pill safe">本地读取</span><p>网站只保存仓库链接、提交号和学生主动提交的摘要，不把完整代码发送给云端 GPT。</p><button>稍后连接 GitHub App</button></div></section><section className="panel setting-card"><PanelHeader title="AI 数据边界" subtitle="遵循已确认的 A / C / D 分类" /><div className="setting-body data-boundaries"><p><b>A</b>培养计划、进展记录、论文草稿可交给云端模型</p><p><b>C</b>代码仓库、专利及保密项目仅限本地模型</p><p><b>D</b>私人评价、身心健康、正式成绩不允许 AI 读取</p></div></section></div>;
}

function LoadingState() {
  return <div className="loading-grid"><div /><div /><div /><div /><section /><aside /></div>;
}
