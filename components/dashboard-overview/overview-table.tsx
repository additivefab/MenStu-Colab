import { overviewStateMeta, type MentorOverviewStudent } from "../../lib/dashboard-overview/types";
import { overviewActionHref, overviewActionLabel, overviewDate, overviewOwnerLabels } from "./overview-actions";

function ResearchPosition({ student }: { student: MentorOverviewStudent }) {
  return <span className="group-overview-position">
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
    <div className="group-overview-table-head" role="row">
      <div className="group-overview-table-grid"><span>状态与原因</span><span>学生</span><span>论文 / 课题位置</span><span>最近可信进展</span><span>下一步与期限</span><span>正在等谁</span></div>
      <span>操作</span>
    </div>
    <div role="rowgroup">
      {students.map((student) => {
        const meta = overviewStateMeta[student.primaryState];
        return <div className={`group-overview-table-row ${student.primaryState}${selectedStudentId === student.studentId ? " selected" : ""}`} role="row" key={student.studentId}>
          <button
            type="button"
            className="group-overview-row-main group-overview-table-grid"
            onClick={() => onOpen(student.studentId)}
            data-overview-student={student.studentId}
            aria-label={`打开 ${student.displayName} 的总览摘要；${meta.label}，${student.primaryReasonLabel}`}
          >
            <span className="group-overview-state-cell"><i aria-hidden="true">{meta.icon}</i><span><strong>{meta.label}</strong><small>{student.primaryReasonLabel}</small>{student.additionalIssueCount ? <em>另有 {student.additionalIssueCount} 项</em> : null}</span></span>
            <span className="group-overview-student-cell"><strong>{student.displayName}</strong><small>{student.grade}级{student.degreeLevel} · {student.stage}</small></span>
            <ResearchPosition student={student} />
            <span className="group-overview-trusted-cell"><strong>{student.latestSubstantiveTitle || "尚无可信进展"}</strong><small>{student.latestSubstantiveAt ? `${overviewDate(student.latestSubstantiveAt)} 已确认` : student.latestSubmittedAt ? `${overviewDate(student.latestSubmittedAt)} 有待确认提交` : "尚无有效提交"}</small></span>
            <span className="group-overview-next-cell"><strong>{student.nextAction || "等待补齐明确行动"}</strong><small>{student.nextActionDueDate ? `期限 ${overviewDate(student.nextActionDueDate, true)}` : "未设置期限"}</small></span>
            <span className={`group-overview-owner ${student.nextOwner}`}><i aria-hidden="true" />{overviewOwnerLabels[student.nextOwner]}</span>
          </button>
          <a className="group-overview-primary-action" href={overviewActionHref(student)} onClick={(event) => event.stopPropagation()}>{overviewActionLabel(student)}</a>
        </div>;
      })}
    </div>
  </div>;
}
