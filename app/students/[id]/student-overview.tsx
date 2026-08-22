"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

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

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const dashboardResponse = await fetch("/api/dashboard", { cache: "no-store" });
      const dashboard = (await dashboardResponse.json()) as { viewer?: { role: ViewerRole }; students?: Student[]; error?: string };
      if (!dashboardResponse.ok) throw new Error(dashboard.error || "学生信息读取失败");
      if (dashboard.viewer?.role === "student") {
        window.location.replace("/");
        return;
      }
      const [proposalResponse, outputResponse] = await Promise.all([
        fetch("/api/proposals", { cache: "no-store" }),
        fetch(`/api/research-outputs?studentId=${encodeURIComponent(studentId)}`, { cache: "no-store" }),
      ]);
      const proposals = (await proposalResponse.json()) as { proposals?: Proposal[]; error?: string };
      const outputPayload = (await outputResponse.json()) as { outputs?: ResearchOutput[]; error?: string };
      if (!proposalResponse.ok) throw new Error(proposals.error || "研究方案读取失败");
      if (!outputResponse.ok) throw new Error(outputPayload.error || "科研成果读取失败");
      const matched = dashboard.students?.find((item) => item.id === studentId) ?? null;
      if (!matched) throw new Error("学生不存在，或当前账号无权查看该学生");
      setStudent(matched);
      setViewerRole(dashboard.viewer?.role ?? null);
      setProposal(proposals.proposals?.find((item) => item.student_id === studentId) ?? null);
      setOutputs(outputPayload.outputs ?? []);
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

  const summary = useMemo(() => {
    const progress = student?.progress ?? [];
    const reviewed = progress.filter((entry) => ["accepted", "changes_requested", "rejected"].includes(entry.review_status)).length;
    const substantive = progress.filter((entry) => entry.assessment === "substantive" || entry.status === "substantive").length;
    const pending = progress.filter((entry) => entry.review_status === "submitted" || entry.review_status === "in_review").length;
    const completedMilestones = proposal?.milestones.filter((item) => item.status === "completed").length ?? 0;
    return {
      reviewed,
      substantive,
      pending,
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

  return <main className="student-page">
    <nav className="student-page-nav"><Link href="/">← 返回驾驶舱</Link><span>探研 · 学生科研全景</span></nav>

    <header className="student-hero">
      <div className="student-hero-profile"><div className="student-hero-avatar">{student.name.slice(-2)}</div><div><p>{student.gradeYear}级{student.degree} · {student.stage}</p><h1>{student.name}</h1><span className={`risk ${student.risk.level}`}>{student.risk.level}</span></div></div>
      <div className="student-hero-focus"><span>当前研究重点</span><strong>{student.currentFocus || "尚未填写"}</strong><small>{student.cadenceDays} 天更新周期 · 最近实质性进展 {dateText(student.lastSubstantiveAt)}</small></div>
    </header>

    <nav className="student-section-nav" aria-label="学生档案章节">
      <a href="#workflow">培养流程</a><a href="#outputs">科研成果</a><a href="#evidence">进展证据</a><a href="#proposal">研究方案</a><a href="#audit">审计记录</a>
    </nav>

    <section className={`student-next-action ${insights.action.tone}`}>
      <div className="student-next-lead"><span>{insights.action.label}</span><h2>{insights.action.title}</h2><p>{insights.action.detail}</p></div>
      <div><span>下一培养节点</span><strong>{insights.nextMilestone?.title || "培养节点已完成或待建立"}</strong><small>{insights.nextMilestone ? targetText(insights.nextMilestone.target_date, insights.nextMilestone.status) : "—"}</small></div>
      <div><span>下次更新窗口</span><strong>{insights.updateWindow}</strong><small>{student.cadenceDays} 天个人更新周期</small></div>
      <div><span>档案缺口</span><strong>{insights.missingInformation.length ? insights.missingInformation.join("、") : "核心档案完整"}</strong><small>{insights.missingInformation.length ? "补齐后可形成完整培养闭环" : "重点、方案、节点、证据与成果均可追溯"}</small></div>
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
        <div className="student-progress-timeline">{student.progress.map((entry) => <article key={entry.id}>
          <div className="student-timeline-marker"><i /><span>{dateText(entry.submitted_at)}</span></div>
          <div className="student-timeline-card"><div><span className={`status-pill review-${entry.review_status}`}>{reviewLabels[entry.review_status]}</span><small>{entry.kind} · #{entry.id}</small></div><h3>{entry.title}</h3><p>{entry.summary}</p><dl><div><dt>核验证据</dt><dd>{entry.evidence || "尚未填写"}</dd></div>{entry.assessment ? <div><dt>审核判断</dt><dd>{entry.assessment === "substantive" ? "实质性进展" : "支持性工作"}{entry.reviewer_name ? ` · ${entry.reviewer_name}` : ""}</dd></div> : null}{entry.reviewer_note ? <div><dt>审核意见</dt><dd>{entry.reviewer_note}</dd></div> : null}</dl>
            <div className="student-evidence-sources" aria-label="证据来源">{entry.evidence_sources.filter((source) => source.source_type !== "attachment").map((source) => <span key={source.id}><b>{source.label}</b>{source.source_ref ? source.source_type === "git" || source.source_type === "url" ? <a href={source.source_ref} target="_blank" rel="noreferrer">打开 ↗</a> : <small>{source.source_ref}</small> : null}{source.content_sha256 ? <em>指纹 {source.content_sha256}</em> : null}</span>)}{!entry.evidence_sources.some((source) => source.source_type !== "attachment") ? <span><b>历史文本证据</b><small>补证时将建立结构化来源</small></span> : null}</div>
            {entry.attachments?.length ? <div className="student-attachment-list" aria-label="提交附件">{entry.attachments.map((attachment) => <a key={attachment.id} href={attachment.download_url}><b>{attachment.file_name}</b><small>{Math.max(1, Math.round(attachment.size_bytes / 1024))} KB · 指纹 {attachment.content_sha256}</small></a>)}</div> : null}
            {entry.audit.length ? <details className="student-progress-audit"><summary>查看审核轨迹（{entry.audit.length}）</summary>{entry.audit.map((event) => <div key={event.id}><i /><span><strong>{event.actor_name || (event.actor_type === "system" ? "系统" : "未知人员")} · {reviewLabels[event.to_status as ReviewStatus] || event.action}</strong><small>{dateText(event.created_at)}{event.note ? ` · ${event.note}` : ""}</small></span></div>)}</details> : null}
            {entry.review_status === "changes_requested" && (viewerRole === "superadmin" || viewerRole === "admin" || viewerRole === "student") ? <details className="student-resubmit"><summary>补充证据并重新提交</summary><form onSubmit={(event) => void resubmitProgress(event, entry)}><label>更新后的结论<textarea name="summary" rows={3} required defaultValue={entry.summary} /></label><label>补充核验证据<textarea name="evidence" rows={3} required defaultValue={entry.evidence} /></label>{entry.kind === "文献" ? <label>论文题目 / DOI<input name="literatureRef" required defaultValue={entry.literature_ref} /></label> : <input type="hidden" name="literatureRef" value={entry.literature_ref || ""} />}<label>Git 链接（可选）<input name="gitUrl" type="url" defaultValue={entry.git_url} placeholder="仅支持 https://" /></label><label>补充附件（可选）<input name="attachments" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.zip,.png,.jpg,.jpeg,.webp,.tif,.tiff" /><small>最多 5 个文件，单个不超过 20 MB</small></label>{progressMessage[entry.id] ? <p role="status">{progressMessage[entry.id]}</p> : null}<button className="primary" disabled={progressBusy === entry.id}>{progressBusy === entry.id ? "提交中…" : "保留原记录并重新提交"}</button></form></details> : null}
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
