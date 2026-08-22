"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type ProgressStatus = "pending" | "substantive" | "supporting" | "supplement" | "rejected";
type ProposalStatus = "draft" | "submitted" | "changes_requested" | "approved";
type MilestoneStatus = "pending" | "in_progress" | "completed" | "blocked";

type StudentProgress = {
  id: number;
  kind: string;
  title: string;
  summary: string;
  evidence: string;
  status: ProgressStatus;
  reviewer_note: string;
  submitted_at: string;
  reviewed_at: string | null;
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

const progressLabels: Record<ProgressStatus, string> = {
  pending: "待审核",
  substantive: "实质性进展",
  supporting: "支持性工作",
  supplement: "需要补充",
  rejected: "非进展",
};

const proposalLabels: Record<ProposalStatus, string> = {
  draft: "方案草稿",
  submitted: "等待导师审核",
  changes_requested: "需要修改",
  approved: "已确认执行",
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetch("/api/dashboard", { cache: "no-store" }),
      fetch("/api/proposals", { cache: "no-store" }),
    ]).then(async ([dashboardResponse, proposalResponse]) => {
      const dashboard = (await dashboardResponse.json()) as { students?: Student[]; error?: string };
      const proposals = (await proposalResponse.json()) as { proposals?: Proposal[]; error?: string };
      if (!dashboardResponse.ok) throw new Error(dashboard.error || "学生信息读取失败");
      if (!proposalResponse.ok) throw new Error(proposals.error || "研究方案读取失败");
      const matched = dashboard.students?.find((item) => item.id === studentId) ?? null;
      if (!matched) throw new Error("学生不存在，或当前账号无权查看该学生");
      if (!active) return;
      setStudent(matched);
      setProposal(proposals.proposals?.find((item) => item.student_id === studentId) ?? null);
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "学生信息读取失败");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [studentId]);

  const summary = useMemo(() => {
    const progress = student?.progress ?? [];
    const reviewed = progress.filter((entry) => entry.status !== "pending").length;
    const substantive = progress.filter((entry) => entry.status === "substantive").length;
    const completedMilestones = proposal?.milestones.filter((item) => item.status === "completed").length ?? 0;
    return {
      reviewed,
      substantive,
      pending: progress.length - reviewed,
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
        if (entry.status === "substantive") weeks[bucket].substantive += 1;
      }
    });
    const maxActivity = Math.max(1, ...weeks.map((week) => week.count));
    const informationSignals = [
      Boolean(student?.currentFocus),
      Boolean(proposal),
      milestones.length > 0,
      progress.length > 0,
      progress.some((entry) => Boolean(entry.evidence)),
    ];
    const informationReady = informationSignals.filter(Boolean).length;
    const planPercent = milestones.length ? Math.round((milestones.filter((item) => item.status === "completed").length / milestones.length) * 100) : 0;

    let action = { label: "保持节奏", title: "按个人周期提交下一条可核验进展", detail: "继续围绕当前研究重点记录新增结论和证据。", tone: "green" };
    if (!proposal) action = { label: "优先行动", title: "建立个人研究方案", detail: "先明确科学问题、研究假设、技术路线与培养节点。", tone: "blue" };
    else if (proposal.status === "changes_requested") action = { label: "优先行动", title: "按导师意见修订研究方案", detail: proposal.reviewer_note || "形成新版本后再次提交导师确认。", tone: "amber" };
    else if (proposal.status === "draft") action = { label: "优先行动", title: "完成研究方案并提交审核", detail: "提交后系统会保留不可覆盖的版本快照。", tone: "blue" };
    else if (proposal.status === "submitted") action = { label: "导师行动", title: "研究方案正在等待导师审核", detail: "审核完成前当前版本保持锁定。", tone: "amber" };
    else if (nextMilestone?.status === "blocked") action = { label: "优先行动", title: `解除阻塞：${nextMilestone.title}`, detail: nextMilestone.evidence_target || "明确阻塞原因、所需决策和替代方案。", tone: "amber" };
    else if (student?.risk.level !== "正常") action = { label: "优先行动", title: "补充一条可核验的实质性进展", detail: `已连续 ${student?.risk.days ?? 0} 天没有确认的实质性进展。`, tone: "amber" };
    else if (progress.some((entry) => entry.status === "pending")) action = { label: "导师行动", title: "审核最新个人进展", detail: `当前有 ${progress.filter((entry) => entry.status === "pending").length} 条证据等待导师判断。`, tone: "blue" };
    else if (nextMilestone) action = { label: "下一节点", title: nextMilestone.title, detail: nextMilestone.evidence_target || "围绕节点目标提交可核验成果。", tone: "green" };

    let updateWindow = "首次实质性进展待确认";
    if (student?.lastSubstantiveAt) {
      const due = new Date(student.lastSubstantiveAt);
      due.setDate(due.getDate() + student.cadenceDays);
      updateWindow = dateText(due.toISOString());
    }
    return { action, informationReady, maxActivity, milestones, nextMilestone, planPercent, updateWindow, weeks };
  }, [proposal, student]);

  if (loading) return <main className="student-page"><div className="student-page-state"><i /><strong>正在整理学生科研全景…</strong></div></main>;
  if (error || !student) return <main className="student-page"><div className="student-page-state error"><strong>暂时无法打开学生页面</strong><p>{error}</p><Link href="/">返回科研进展驾驶舱</Link></div></main>;

  const flow = [
    { label: "学生身份", value: `${student.gradeYear}级${student.degree}`, note: student.stage, tone: "blue" },
    { label: "研究方案", value: proposal ? proposalLabels[proposal.status] : "尚未建立", note: proposal?.title || "等待学生撰写", tone: proposal?.status === "approved" ? "green" : "blue" },
    { label: "培养节点", value: `${summary.completedMilestones}/${summary.totalMilestones} 已完成`, note: proposal?.milestones.find((item) => item.status === "in_progress")?.title || "暂无进行中节点", tone: summary.completedMilestones ? "green" : "blue" },
    { label: "个人进展", value: `${student.progress.length} 条`, note: student.latestTitle, tone: "blue" },
    { label: "导师审核", value: `${summary.reviewed} 已审 · ${summary.pending} 待审`, note: `${summary.substantive} 条实质性进展`, tone: summary.pending ? "amber" : "green" },
    { label: "当前状态", value: student.risk.level, note: `${student.risk.days} 天距最近实质性进展`, tone: student.risk.level === "正常" ? "green" : "amber" },
  ];

  return <main className="student-page">
    <nav className="student-page-nav"><Link href="/">← 返回驾驶舱</Link><span>探研 · 学生科研全景</span></nav>

    <header className="student-hero">
      <div className="student-hero-profile"><div className="student-hero-avatar">{student.name.slice(-2)}</div><div><p>{student.gradeYear}级{student.degree} · {student.stage}</p><h1>{student.name}</h1><span className={`risk ${student.risk.level}`}>{student.risk.level}</span></div></div>
      <div className="student-hero-focus"><span>当前研究重点</span><strong>{student.currentFocus || "尚未填写"}</strong><small>{student.cadenceDays} 天更新周期 · 最近实质性进展 {dateText(student.lastSubstantiveAt)}</small></div>
    </header>

    <section className={`student-next-action ${insights.action.tone}`}>
      <div className="student-next-lead"><span>{insights.action.label}</span><h2>{insights.action.title}</h2><p>{insights.action.detail}</p></div>
      <div><span>下一培养节点</span><strong>{insights.nextMilestone?.title || "培养节点已完成或待建立"}</strong><small>{insights.nextMilestone ? targetText(insights.nextMilestone.target_date, insights.nextMilestone.status) : "—"}</small></div>
      <div><span>下次更新窗口</span><strong>{insights.updateWindow}</strong><small>{student.cadenceDays} 天个人更新周期</small></div>
      <div><span>档案要素</span><strong>{insights.informationReady}/5 已具备</strong><small>重点、方案、节点、进展与证据</small></div>
    </section>

    <section className="student-flow-card">
      <div className="student-section-head"><div><span>FLOW</span><h2>科研培养流程图</h2><p>从研究身份、方案与培养节点，一直追踪到个人进展、导师审核和当前风险。</p></div></div>
      <ol className="student-flow" aria-label={`${student.name}科研培养流程`}>{flow.map((step, index) => <li key={step.label} className={step.tone}><div><i>{index + 1}</i><span>{step.label}</span><strong>{step.value}</strong><small>{step.note}</small></div>{index < flow.length - 1 ? <b aria-hidden="true">→</b> : null}</li>)}</ol>
    </section>

    <section className="student-page-metrics">
      <article><span>全部个人进展</span><strong>{student.progress.length}</strong><small>只包含 {student.name} 的记录</small></article>
      <article><span>实质性进展</span><strong>{summary.substantive}</strong><small>影响最近进展日期与预警</small></article>
      <article><span>培养节点</span><strong>{summary.completedMilestones}/{summary.totalMilestones}</strong><small>完成数 / 总数</small></article>
      <article><span>方案版本</span><strong>{proposal?.current_version ?? 0}</strong><small>{proposal ? proposalLabels[proposal.status] : "尚无方案"}</small></article>
    </section>

    <section className="student-insight-grid">
      <article className="student-page-panel student-plan-progress">
        <div className="student-section-head"><div><span>LEARNING PLAN</span><h2>培养计划进度</h2><p>按培养节点展示完成度和下一目标，不等同于学生评分。</p></div><em>{insights.planPercent}%</em></div>
        <div className="student-plan-track"><i style={{ width: `${insights.planPercent}%` }} /></div>
        <div className="student-plan-timeline">{insights.milestones.map((milestone, index) => <div key={milestone.id} className={milestone.status}><i>{index + 1}</i><span><strong>{milestone.title}</strong><small>{milestoneLabels[milestone.status]} · {targetText(milestone.target_date, milestone.status)}</small></span></div>)}{!insights.milestones.length ? <div className="student-empty">研究方案中尚未建立培养节点</div> : null}</div>
      </article>
      <article className="student-page-panel student-activity-panel">
        <div className="student-section-head"><div><span>EVIDENCE ACTIVITY</span><h2>最近 8 周证据活动</h2><p>只统计个人进展记录数量，绿色标记其中的实质性进展。</p></div></div>
        <div className="student-activity-bars">{insights.weeks.map((week) => <div key={week.start.toISOString()} title={`${week.label}：${week.count} 条进展，其中 ${week.substantive} 条实质性进展`}><strong>{week.count || "·"}</strong><span><i style={{ height: `${Math.max(week.count ? 15 : 5, (week.count / insights.maxActivity) * 100)}%` }} />{week.substantive ? <b style={{ height: `${Math.max(10, (week.substantive / insights.maxActivity) * 100)}%` }} /> : null}</span><small>{week.label}</small></div>)}</div>
      </article>
    </section>

    <div className="student-page-grid">
      <section className="student-page-panel student-progress-panel">
        <div className="student-section-head"><div><span>PROGRESS</span><h2>个人进展时间线</h2><p>飞书智能纪要和学生主动提交均归入这里。</p></div><em>{student.progress.length}</em></div>
        <div className="student-progress-timeline">{student.progress.map((entry) => <article key={entry.id}>
          <div className="student-timeline-marker"><i /><span>{dateText(entry.submitted_at)}</span></div>
          <div className="student-timeline-card"><div><span className={`status-pill ${entry.status === "pending" ? "pending" : "safe"}`}>{progressLabels[entry.status]}</span><small>{entry.kind} · #{entry.id}</small></div><h3>{entry.title}</h3><p>{entry.summary}</p><dl><div><dt>核验证据</dt><dd>{entry.evidence || "尚未填写"}</dd></div>{entry.reviewer_note ? <div><dt>导师意见</dt><dd>{entry.reviewer_note}</dd></div> : null}</dl></div>
        </article>)}{!student.progress.length ? <div className="student-empty">尚无个人进展记录</div> : null}</div>
      </section>

      <aside className="student-page-side">
        <section className="student-page-panel">
          <div className="student-section-head"><div><span>PROPOSAL</span><h2>研究方案</h2><p>{proposal ? `${proposalLabels[proposal.status]} · 第 ${proposal.current_version} 版` : "尚未建立研究方案"}</p></div></div>
          {proposal ? <><h3 className="student-proposal-title">{proposal.title}</h3><div className="student-proposal-details"><DetailBlock label="科学问题" value={proposal.scientific_question} /><DetailBlock label="研究假设" value={proposal.hypothesis} /><DetailBlock label="研究目标" value={proposal.objectives} /><DetailBlock label="创新点" value={proposal.innovation} /><DetailBlock label="文献基础" value={proposal.literature_basis} /><DetailBlock label="技术路线" value={proposal.methodology} /><DetailBlock label="数据与伦理边界" value={proposal.data_ethics} /><DetailBlock label="风险与备选方案" value={proposal.risks} /><DetailBlock label="资源需求" value={proposal.resources} /><DetailBlock label="参考文献" value={proposal.references_text} />{proposal.reviewer_note ? <DetailBlock label="导师意见" value={proposal.reviewer_note} /> : null}</div></> : <div className="student-empty">等待学生自行撰写并提交研究方案</div>}
        </section>

        <section className="student-page-panel">
          <div className="student-section-head"><div><span>MILESTONES</span><h2>培养节点</h2><p>方案确认后的执行路线。</p></div></div>
          <div className="student-milestones">{proposal?.milestones.map((milestone, index) => <article key={milestone.id} className={milestone.status}><i>{index + 1}</i><div><span>{milestoneLabels[milestone.status]}</span><h3>{milestone.title}</h3><p>{milestone.evidence_target || "尚未填写验收证据"}</p><small>目标：{milestone.target_date || "待确定"}</small></div></article>)}{!proposal?.milestones.length ? <div className="student-empty">尚无培养节点</div> : null}</div>
        </section>

        <section className="student-page-panel">
          <div className="student-section-head"><div><span>AUDIT</span><h2>方案审计与版本</h2><p>所有提交、审核与节点变化均保留记录。</p></div></div>
          <div className="student-version-strip">{proposal?.versions.map((version) => <div key={version.id}><strong>V{version.version_number}</strong><span>{version.submitted_by_name} · {dateText(version.created_at)}</span></div>)}{!proposal?.versions.length ? <span>尚无已保存版本</span> : null}</div>
          <div className="student-audit">{proposal?.audit.map((event) => <article key={event.id}><i /><div><strong>{auditLabels[event.action] || event.action}</strong><span>{event.actor_name} · {dateText(event.created_at)}</span><p>{event.detail}</p></div></article>)}{!proposal?.audit.length ? <div className="student-empty">尚无方案审计记录</div> : null}</div>
        </section>
      </aside>
    </div>
  </main>;
}
