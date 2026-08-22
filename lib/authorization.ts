import type { AppUser } from "./feishu-auth";
import { getD1 } from "./database";
import { type StudentScope } from "./access-policy";

export { roleCanViewStudent, scopeSql, type StudentScope } from "./access-policy";

export async function getStudentScope(user: AppUser): Promise<StudentScope> {
  if (user.role === "admin") return { all: true, studentIds: [] };
  if (user.role === "student") return { all: false, studentIds: user.studentId ? [user.studentId] : [] };
  if (user.role !== "mentor") return { all: false, studentIds: [] };

  const { results } = await getD1().prepare(`SELECT student_id FROM mentor_student_assignments
    WHERE mentor_user_id = ? AND active = 1 ORDER BY student_id`)
    .bind(user.id)
    .all<{ student_id: string }>();
  return { all: false, studentIds: results.map((item) => item.student_id) };
}

export async function canViewStudent(user: AppUser, studentId: string) {
  if (user.role === "admin") return true;
  if (user.role === "student") return user.studentId === studentId;
  if (user.role !== "mentor") return false;
  const assignment = await getD1().prepare(`SELECT id FROM mentor_student_assignments
    WHERE mentor_user_id = ? AND student_id = ? AND active = 1`)
    .bind(user.id, studentId)
    .first();
  return Boolean(assignment);
}

export async function canReviewStudent(user: AppUser, studentId: string) {
  if (user.role !== "mentor") return false;
  const assignment = await getD1().prepare(`SELECT id FROM mentor_student_assignments
    WHERE mentor_user_id = ? AND student_id = ? AND active = 1 AND can_review = 1`)
    .bind(user.id, studentId)
    .first();
  return Boolean(assignment);
}
