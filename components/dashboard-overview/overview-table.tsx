import { overviewStateMeta, type MentorOverviewStudent } from "../../lib/dashboard-overview/types";
import { overviewActionHref, overviewActionLabel, overviewDate, overviewOwnerLabels } from "./overview-actions";

function ResearchPosition({ student }: { student: MentorOverviewStudent }) {
  return <span className="group-overview-position" role="cell">
    <span><b>论</b><em>{student.paperPosition ? `${student.paperPosition.title} · ${student.paperPosition.stage}` : "尚无论文主线"}</em></span>
    <span><b>项</b><em>{student.projectPosition ? `${student.projectPosition.title} · ${student.projectPosition.stage}` : "尚无课题主线"}</em></span>
  </span>;
}

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
      <span role="columnheader">状态与原因</span><span role="columnheader">学生</span><span role="columnheader">论文 / 课题位置</span><span role="columnheader">最近可信进展</span><span role="columnheader">下一步与期限</span><span role="columnheader">正在等谁</span><span role="columnheader">操作</span>
    </div>
    <div role="rowgroup">
      {students.map((student) => {
        const meta = overviewStateMeta[student.primaryState];
        const primaryIssue = student.issues[0];
        const issueDate = primaryIssue?.dueDate
          ? `截止 ${overviewDate(primaryIssue.dueDate, true)}`
          : primaryIssue?.occurredAt ? `记录于 ${overviewDate(primaryIssue.occurredAt, true)}` : "日期待补齐";
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
            <span className="group-overview-state-cell" role="cell"><i aria-hidden="true">{meta.icon}</i><span><strong>{meta.label}</strong><small>{student.primaryReasonLabel}</small><time>{issueDate}</time>{student.additionalIssueCount ? <em>另有 {student.additionalIssueCount} 项</em> : null}</span></span>
            <span className="group-overview-student-cell" role="cell"><button
              type="button"
              onClick={(event) => { event.stopPropagation(); onOpen(student.studentId); }}
              data-overview-student={student.studentId}
              aria-label={`打开 ${student.displayName} 的总览摘要；${meta.label}，${student.primaryReasonLabel}`}
            ><strong>{student.displayName}</strong><small>{student.grade}级{student.degreeLevel} · {student.stage}</small></button></span>
            <ResearchPosition student={student} />
            <span className="group-overview-trusted-cell" role="cell"><strong>{student.latestSubstantiveTitle || "尚无可信进展"}</strong><small>{student.latestSubstantiveAt ? `${overviewDate(student.latestSubstantiveAt)} 已确认` : student.latestSubmittedAt ? `${overviewDate(student.latestSubmittedAt)} 有待确认提交` : "尚无有效提交"}</small></span>
            <span className="group-overview-next-cell" role="cell"><strong>{student.nextAction || "等待补齐明确行动"}</strong><small>{student.nextActionDueDate ? `期限 ${overviewDate(student.nextActionDueDate, true)}` : "未设置期限"}</small></span>
            <span className={`group-overview-owner ${student.nextOwner}`} role="cell"><i aria-hidden="true" />{overviewOwnerLabels[student.nextOwner]}</span>
          <span className="group-overview-action-cell" role="cell"><a className="group-overview-primary-action" href={overviewActionHref(student)} onClick={(event) => event.stopPropagation()}>{overviewActionLabel(student)}</a></span>
        </div>;
      })}
    </div>
  </div>;
}
