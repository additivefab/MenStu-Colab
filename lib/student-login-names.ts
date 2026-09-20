// Login labels only. Authorization always uses the existing immutable student/user IDs.
// Non-Chinese names use initials; the single-word name Abbasi keeps its spelling.
const rosterLoginBases: readonly (readonly [string, string])[] = [
  ["student-001", "why"], ["student-002", "sy"], ["student-003", "cc"],
  ["student-004", "hyf"], ["student-005", "mjur"], ["student-006", "abbasi"],
  ["student-007", "mn"], ["student-008", "szh"], ["student-009", "lqy"],
  ["student-010", "shy"], ["student-011", "lwj"], ["student-012", "yrx"],
  ["student-013", "jf"], ["student-014", "hyh"], ["student-015", "qh"],
  ["student-016", "fz"], ["student-017", "wsk"], ["student-018", "zyj"],
  ["student-019", "yc"], ["student-020", "mzn"], ["student-021", "cy"],
  ["student-022", "zxr"], ["student-023", "wjj"], ["student-024", "gy"],
  ["student-025", "lxb"], ["student-026", "zhh"],
];

export function uniqueLoginNames(entries: readonly (readonly [string, string])[]) {
  const reserved = new Set(entries.map(([, base]) => base));
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const [id, base] of entries) {
    if (result.has(id) || !/^[a-z][a-z0-9]{0,47}$/.test(base)) throw new Error("登录名配置无效");
    let name = base;
    let suffix = 2;
    if (used.has(name)) {
      do { name = `${base}${suffix++}`; } while (used.has(name) || reserved.has(name));
    }
    used.add(name);
    result.set(id, name);
  }
  return result;
}

export const studentLoginNames = uniqueLoginNames(rosterLoginBases);
export function studentLoginName(studentId: string) {
  return studentLoginNames.get(studentId) ?? studentId;
}
