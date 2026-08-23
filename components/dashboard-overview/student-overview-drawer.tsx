import { useEffect, useRef } from "react";
import { overviewStateMeta, type MentorOverviewStudent } from "../../lib/dashboard-overview/types";
import { overviewActionHref, overviewActionLabel, overviewDate, overviewOwnerLabels } from "./overview-actions";

export function StudentOverviewDrawer({ student, onClose }: { student: MentorOverviewStudent; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const meta = overviewStateMeta[student.primaryState];

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return <div className="group-overview-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="group-overview-drawer" role="dialog" aria-modal="true" aria-labelledby="group-overview-drawer-title">
      <header>
        <div><span>STUDENT BRIEF</span><h2 id="group-overview-drawer-title">{student.displayName}</h2><p>{student.grade}级{student.degreeLevel} · {student.stage} · {student.currentFocus || "研究方向待补齐"}</p></div>
        <button type="button" ref={closeRef} onClick={onClose} aria-label="关闭学生进度摘要">×</button>
      </header>
      <section className={`group-overview-drawer-primary ${student.primaryState}`}>
        <div><i aria-hidden="true">{meta.icon}</i><span><small>当前主状态</small><strong>{meta.label}</strong></span></div>
        <p>{student.primaryReasonLabel}</p>
        <dl><div><dt>下一责任人</dt><dd>{overviewOwnerLabels[student.nextOwner]}</dd></div><div><dt>最早期限</dt><dd>{student.issues.find((issue) => issue.dueDate)?.dueDate ? overviewDate(student.issues.find((issue) => issue.dueDate)?.dueDate ?? null, true) : "暂无硬期限"}</dd></div></dl>
      </section>

      <section className="group-overview-drawer-section">
        <header><div><span>全部事实</span><h3>为什么排在这里</h3></div><strong>{student.issues.length}</strong></header>
        <div className="group-overview-issue-list">{student.issues.map((issue, index) => <article className={issue.state} key={`${issue.code}-${issue.sourceType}-${issue.sourceId}-${index}`}>
          <i aria-hidden="true">{overviewStateMeta[issue.state].icon}</i><div><strong>{issue.label}</strong><small>{overviewStateMeta[issue.state].label} · {overviewOwnerLabels[issue.owner]}{issue.dueDate ? ` · 期限 ${overviewDate(issue.dueDate, true)}` : issue.occurredAt ? ` · ${overviewDate(issue.occurredAt)}` : ""}</small></div>
        </article>)}</div>
      </section>

      <section className="group-overview-drawer-section">
        <header><div><span>双轨位置</span><h3>论文与课题分开判断</h3></div></header>
        <div className="group-overview-track-cards">
          <article><span>论文轨</span><strong>{student.paperPosition?.title || "尚无论文主线"}</strong><small>{student.paperPosition ? `${student.paperPosition.stage} · ${student.paperPosition.status}` : "需要在学生档案中补齐"}</small></article>
          <article><span>课题轨</span><strong>{student.projectPosition?.title || "尚无确认课题"}</strong><small>{student.projectPosition ? `${student.projectPosition.stage} · ${student.projectPosition.status}` : "需要补齐方案或培养节点"}</small></article>
        </div>
      </section>

      <section className="group-overview-drawer-section">
        <header><div><span>可信进展</span><h3>最近三条导师确认记录</h3></div><strong>{student.recentSubstantive.length}</strong></header>
        <div className="group-overview-trusted-list">{student.recentSubstantive.map((progress) => <article key={progress.id}><time>{overviewDate(progress.confirmedAt)}</time><div><strong>{progress.title}</strong><small>{progress.kind} · 已确认为实质性进展</small></div></article>)}{!student.recentSubstantive.length ? <p>尚无导师确认的实质性进展。{student.latestSubmittedAt ? `最近有效提交在 ${overviewDate(student.latestSubmittedAt)}，仍未计入可信进展。` : ""}</p> : null}</div>
      </section>

      <footer>
        <div><span>唯一主动作</span><small>所有写操作仍由原审核与指导入口重新校验权限</small></div>
        <a href={overviewActionHref(student)}>{overviewActionLabel(student)} →</a>
      </footer>
    </aside>
  </div>;
}
