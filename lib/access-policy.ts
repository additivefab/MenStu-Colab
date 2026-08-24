export type StudentScope = {
  all: boolean;
  studentIds: string[];
};

type ScopedUser = {
  role: string;
  studentId: string | null;
};

export function roleCanViewStudent(user: ScopedUser, studentId: string, assignedStudentIds: string[]) {
  if (user.role === "superadmin") return true;
  if (user.role === "admin") return assignedStudentIds.includes(studentId);
  if (user.role === "student") return Boolean(user.studentId && user.studentId === studentId);
  return false;
}

export function isOwnStudentRecord(user: Pick<ScopedUser, "studentId">, studentId: string) {
  return Boolean(user.studentId && user.studentId === studentId);
}

export function scopeSql(scope: StudentScope, column: string) {
  if (scope.all) return { clause: "", bindings: [] as string[] };
  if (!scope.studentIds.length) return { clause: " AND 1 = 0", bindings: [] as string[] };
  return {
    clause: ` AND ${column} IN (${scope.studentIds.map(() => "?").join(",")})`,
    bindings: scope.studentIds,
  };
}
