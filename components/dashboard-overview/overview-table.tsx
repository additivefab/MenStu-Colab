import { overviewStateMeta, type MentorOverviewStudent } from "../../lib/dashboard-overview/types";
import { overviewActionHref, overviewActionLabel, overviewDate, overviewOwnerLabels } from "./overview-actions";
import { overviewNextActionText } from "./overview-view-model";

export function OverviewTable({
  students,
  selectedStudentId,
  onOpen,
}: {
  students: MentorOverviewStudent[];
  selectedStudentId: string | null;
  onOpen: (studentId: string) => void;
}) {
  return <div className="group-overview-table" role="table" aria-label="全组科研进度">
    <div className="group-overview-table-head group-overview-table-grid" role="row">
      <span role="columnheader">学生</span><span role="columnheader">进度状态</span><span role="columnheader">最近确认进展</span><span role="columnheader">下一步与期限</span><span role="columnheader">操作</span>
    </div>
    <div role="rowgroup">
      {students.map((student) => {
        const meta = overviewStateMeta[student.primaryState];
        return <div
          className={`group-overview-table-row group-overview-table-grid ${student.primaryState}${selectedStudentId === student.studentId ? " selected" : ""}`}
          role="row"
          key={student.studentId}
          tabIndex={0}
          aria-label={`打开 ${student.displayName} 的总览摘要；${meta.label}，${student.primaryReasonLabel}`}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a, button, input, select, textarea")) return;
            onOpen(student.studentId);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            onOpen(student.studentId);
          }}
        >
            <span className="group-overview-student-cell" role="cell"><button
              type="button"
              onClick={(event) => { event.stopPropagation(); onOpen(student.studentId); }}
              data-overview-student={student.studentId}
              aria-label={`打开 ${student.displayName} 的总览摘要；${meta.label}，${student.primaryReasonLabel}`}
            ><strong>{student.displayName}</strong><small>{student.grade}级{student.degreeLevel} · {student.stage}</small></button></span>
            <span className="group-overview-state-cell" role="cell"><i aria-hidden="true">{meta.icon}</i><span><strong>{meta.label}</strong><small>{student.primaryReasonLabel}</small>{student.additionalIssueCount ? <em>另有 {student.additionalIssueCount} 项进度事项</em> : null}{student.counters.blocked > 0 ? <a className="group-overview-problem-link" href={`/?mentorView=issues&issueStudent=${encodeURIComponent(student.studentId)}`} onClick={(event) => event.stopPropagation()}>待解决问题 {student.counters.blocked} 项 →</a> : null}</span></span>
            <span className="group-overview-trusted-cell" role="cell"><strong>{student.latestSubstantiveTitle || "暂无已确认进展"}</strong><small>{student.latestSubstantiveAt ? `${overviewDate(student.latestSubstantiveAt)} 已确认` : student.latestSubmittedAt ? `${overviewDate(student.latestSubmittedAt)} 有尚未确认的提交` : "暂无提交"}</small></span>
            <span className="group-overview-next-cell" role="cell"><strong>{overviewNextActionText(student)}</strong><small>{student.nextActionDueDate ? `${overviewDate(student.nextActionDueDate, true)} · ` : ""}{overviewOwnerLabels[student.nextOwner]}跟进</small></span>
          <span className="group-overview-action-cell" role="cell"><a className="group-overview-primary-action" href={overviewActionHref(student)} onClick={(event) => event.stopPropagation()}>{overviewActionLabel(student)}</a></span>
        </div>;
      })}
    </div>
  </div>;
}
