export type RosterStudent = {
  id: string;
  name: string;
  degree: "博士" | "硕士";
  gradeYear: number;
};

export const confirmedRoster: readonly RosterStudent[] = [
  { id: "student-001", name: "温浩钰", degree: "博士", gradeYear: 2022 },
  { id: "student-002", name: "佘阳", degree: "博士", gradeYear: 2023 },
  { id: "student-003", name: "曹琛", degree: "博士", gradeYear: 2024 },
  { id: "student-004", name: "何逸凡", degree: "博士", gradeYear: 2024 },
  { id: "student-005", name: "Muhammad Jalil Ur Rehman", degree: "博士", gradeYear: 2024 },
  { id: "student-006", name: "Abbasi", degree: "博士", gradeYear: 2024 },
  { id: "student-007", name: "Mahmoud Noureldien", degree: "博士", gradeYear: 2024 },
  { id: "student-008", name: "孙正昊", degree: "博士", gradeYear: 2025 },
  { id: "student-009", name: "吕秋阳", degree: "博士", gradeYear: 2025 },
  { id: "student-010", name: "邵华阳", degree: "博士", gradeYear: 2025 },
  { id: "student-011", name: "骆文杰", degree: "博士", gradeYear: 2025 },
  { id: "student-012", name: "叶睿昕", degree: "博士", gradeYear: 2025 },
  { id: "student-013", name: "蒋锋", degree: "硕士", gradeYear: 2023 },
  { id: "student-014", name: "侯雨禾", degree: "硕士", gradeYear: 2023 },
  { id: "student-015", name: "邱昊", degree: "硕士", gradeYear: 2023 },
  { id: "student-016", name: "冯卓", degree: "硕士", gradeYear: 2024 },
  { id: "student-017", name: "王少康", degree: "硕士", gradeYear: 2024 },
  { id: "student-018", name: "张永基", degree: "硕士", gradeYear: 2024 },
  { id: "student-019", name: "于畅", degree: "硕士", gradeYear: 2024 },
  { id: "student-020", name: "马振宁", degree: "硕士", gradeYear: 2024 },
  { id: "student-021", name: "陈艳", degree: "硕士", gradeYear: 2025 },
  { id: "student-022", name: "张新茹", degree: "硕士", gradeYear: 2025 },
  { id: "student-023", name: "王俊杰", degree: "硕士", gradeYear: 2025 },
  { id: "student-024", name: "桂洋", degree: "硕士", gradeYear: 2025 },
  { id: "student-025", name: "李小博", degree: "硕士", gradeYear: 2025 },
  { id: "student-026", name: "钟昊航", degree: "硕士", gradeYear: 2025 },
];

export function getConfirmedRosterStudent(studentId: string) {
  return confirmedRoster.find((student) => student.id === studentId) ?? null;
}
