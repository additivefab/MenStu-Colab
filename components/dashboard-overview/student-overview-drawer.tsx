import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { overviewStateMeta, type MentorOverviewStudent } from "../../lib/dashboard-overview/types";
import { overviewActionHref, overviewActionLabel, overviewDate, overviewOwnerLabels } from "./overview-actions";
import { earliestOverviewDueDate } from "./overview-view-model";

export function StudentOverviewDrawer({ student, onClose }: { student: MentorOverviewStudent; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const meta = overviewStateMeta[student.primaryState];

  useEffect(() => {
    const drawer = drawerRef.current;
    const layer = layerRef.current;
    closeRef.current?.focus();
    const background = Array.from(document.body.children).filter((element) => element !== layer);
    const backgroundState = background.map((element) => ({
      element,
      inert: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    background.forEach((element) => {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !drawer.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      backgroundState.forEach(({ element, inert, ariaHidden }) => {
        if (!inert) element.removeAttribute("inert");
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
    };
  }, [onClose]);

  return createPortal(<div ref={layerRef} className="group-overview-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={drawerRef} className="group-overview-drawer" role="dialog" aria-modal="true" aria-labelledby="group-overview-drawer-title">
      <header>
        <div><span>STUDENT BRIEF</span><h2 id="group-overview-drawer-title">{student.displayName}</h2><p>{student.grade}级{student.degreeLevel} · {student.stage} · {student.currentFocus || "研究方向待补齐"}</p></div>
        <button type="button" ref={closeRef} onClick={onClose} aria-label="关闭学生进度摘要">×</button>
      </header>
      <section className={`group-overview-drawer-primary ${student.primaryState}`}>
        <div><i aria-hidden="true">{meta.icon}</i><span><small>当前主状态</small><strong>{meta.label}</strong></span></div>
        <p>{student.primaryReasonLabel}</p>
        <dl><div><dt>下一责任人</dt><dd>{overviewOwnerLabels[student.nextOwner]}</dd></div><div><dt>最早期限</dt><dd>{earliestOverviewDueDate(student) ? overviewDate(earliestOverviewDueDate(student), true) : "暂无硬期限"}</dd></div></dl>
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
  </div>, document.body);
}
