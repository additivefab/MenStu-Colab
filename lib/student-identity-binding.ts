export type ExpectedStudentIdentityBinding = {
  studentId: string;
  openId: string;
};

export type StoredStudentIdentityBinding = {
  student_id: string;
  feishu_open_id: string;
  active: number;
};

export function areStudentIdentityBindingsExact(
  stored: StoredStudentIdentityBinding[],
  expected: ExpectedStudentIdentityBinding[],
) {
  if (stored.length !== expected.length) return false;

  const expectedByStudent = new Map<string, string>();
  const expectedOpenIds = new Set<string>();
  for (const binding of expected) {
    if (expectedByStudent.has(binding.studentId) || expectedOpenIds.has(binding.openId)) return false;
    expectedByStudent.set(binding.studentId, binding.openId);
    expectedOpenIds.add(binding.openId);
  }

  const storedStudents = new Set<string>();
  const storedOpenIds = new Set<string>();
  for (const binding of stored) {
    if (binding.active !== 1
      || storedStudents.has(binding.student_id)
      || storedOpenIds.has(binding.feishu_open_id)
      || expectedByStudent.get(binding.student_id) !== binding.feishu_open_id) {
      return false;
    }
    storedStudents.add(binding.student_id);
    storedOpenIds.add(binding.feishu_open_id);
  }

  return storedStudents.size === expected.length;
}
