import { overviewStateMeta, type MentorOverviewStudent } from "../../lib/dashboard-overview/types";
import { overviewActionHref, overviewActionLabel, overviewDate, overviewOwnerLabels } from "./overview-actions";
import { overviewNextActionText } from "./overview-view-model";
import { MonthlyDeliveryProgress } from "../monthly-delivery-progress";
import deliveryStyles from "../monthly-delivery-progress.module.css";

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
      return <article className={`${student.primaryState} ${deliveryStyles.mobileCard}`} key={student.studentId}>
        <button type="button" onClick={() => onOpen(student.studentId)} data-overview-student={student.studentId} aria-label={`打开 ${student.displayName} 的进度摘要`}>
          <h3>{student.displayName}<small>{student.grade}级{student.degreeLevel} · {student.stage}</small></h3>
        </button>
        {student.monthlyDelivery ? <div className={deliveryStyles.mobileProgress}><MonthlyDeliveryProgress summary={student.monthlyDelivery} compact /></div> : null}
        <div className={deliveryStyles.mobileContext}>
          <header><span><i aria-hidden="true">{meta.icon}</i>{meta.label}</span><small>{overviewOwnerLabels[student.nextOwner]}</small></header>
          <p>{student.primaryReasonLabel}{student.additionalIssueCount ? ` · 另有 ${student.additionalIssueCount} 项进度事项` : ""}</p>
          <dl><div><dt>下一步</dt><dd>{overviewNextActionText(student)}{student.nextActionDueDate ? ` · ${overviewDate(student.nextActionDueDate)}` : ""}</dd></div></dl>
        </div>
        <div className="group-overview-mobile-actions"><a href={overviewActionHref(student)}>{overviewActionLabel(student)}</a>{student.counters.blocked > 0 ? <a className="group-overview-problem-link" href={`/?mentorView=issues&issueStudent=${encodeURIComponent(student.studentId)}`}>待解决问题 {student.counters.blocked} 项</a> : null}</div>
      </article>;
    })}
  </div>;
}
