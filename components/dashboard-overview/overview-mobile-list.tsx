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
      return <article className={student.primaryState} key={student.studentId}>
        <button type="button" onClick={() => onOpen(student.studentId)} data-overview-student={student.studentId} aria-label={`打开 ${student.displayName} 的进度摘要`}>
          <header><span><i aria-hidden="true">{meta.icon}</i>{meta.label}</span><small>{overviewOwnerLabels[student.nextOwner]}</small></header>
          <h3>{student.displayName}<small>{student.grade}级{student.degreeLevel} · {student.stage}</small></h3>
          <p>{student.primaryReasonLabel}{student.additionalIssueCount ? ` · 另有 ${student.additionalIssueCount} 项` : ""}</p>
          <dl><div><dt>下一步</dt><dd>{student.nextAction || "等待补齐明确行动"}{student.nextActionDueDate ? ` · ${overviewDate(student.nextActionDueDate)}` : ""}</dd></div></dl>
        </button>
        <a href={overviewActionHref(student)}>{overviewActionLabel(student)}</a>
      </article>;
    })}
  </div>;
}
