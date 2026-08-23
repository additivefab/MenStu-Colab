import { overviewStateMeta, type MentorOverviewStudent } from "../../lib/dashboard-overview/types";
import { overviewActionHref, overviewActionLabel, overviewDate, overviewOwnerLabels } from "./overview-actions";

export function OverviewMobileList({
  students,
  onOpen,
}: {
  students: MentorOverviewStudent[];
  onOpen: (studentId: string) => void;
}) {
  return <div className="group-overview-mobile-list">
    {students.map((student) => {
      const meta = overviewStateMeta[student.primaryState];
      const primaryIssue = student.issues[0];
      const issueDate = primaryIssue?.dueDate
        ? `截止 ${overviewDate(primaryIssue.dueDate, true)}`
        : primaryIssue?.occurredAt ? `记录于 ${overviewDate(primaryIssue.occurredAt, true)}` : "日期待补齐";
      return <article className={student.primaryState} key={student.studentId}>
        <button type="button" onClick={() => onOpen(student.studentId)} data-overview-student={student.studentId} aria-label={`打开 ${student.displayName} 的进度摘要`}>
          <header><span><i aria-hidden="true">{meta.icon}</i>{meta.label}</span><small>{overviewOwnerLabels[student.nextOwner]}</small></header>
          <h3>{student.displayName}<small>{student.grade}级{student.degreeLevel} · {student.stage}</small></h3>
          <p>{student.primaryReasonLabel}{student.additionalIssueCount ? ` · 另有 ${student.additionalIssueCount} 项` : ""}<time>{issueDate}</time></p>
          <dl><div><dt>研究位置</dt><dd>{student.paperPosition?.title || student.projectPosition?.title || "待补齐"}</dd></div><div><dt>下一步</dt><dd>{student.nextAction || "等待补齐明确行动"}{student.nextActionDueDate ? ` · ${overviewDate(student.nextActionDueDate)}` : ""}</dd></div></dl>
        </button>
        <a href={overviewActionHref(student)}>{overviewActionLabel(student)}</a>
      </article>;
    })}
  </div>;
}
