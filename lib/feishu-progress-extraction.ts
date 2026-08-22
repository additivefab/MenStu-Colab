export type ProgressStudent = {
  id: string;
  displayName: string;
};

export type StudentProgressDraft = {
  studentId: string;
  studentName: string;
  title: string;
  summary: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsStudentName(text: string, name: string) {
  if (/^[\p{Script=Han}·]+$/u.test(name)) return text.includes(name);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

function studentHeading(line: string, students: ProgressStudent[]) {
  const normalized = line.replace(/^[-*#\s]+/, "").replace(/^@/, "").trim();
  return students.find((student) => {
    const name = escapeRegExp(student.displayName);
    return new RegExp(
      `^@?${name}(?:\\s*[：:·—-]\\s*|\\s*(?:科研|研究|课题|工作|实验|算法|论文)?(?:进展|汇报|情况)\\s*[：:]?)`,
      "iu",
    ).test(normalized) || normalized === student.displayName;
  });
}

function stripStudentHeading(line: string, studentName: string) {
  return line
    .replace(new RegExp(`^[-*#\\s]*@?${escapeRegExp(studentName)}\\s*`, "iu"), "")
    .replace(/^(?:科研|研究|课题|工作|实验|算法|论文)?(?:进展|汇报|情况)?\s*[：:·—-]?\s*/u, "")
    .trim();
}

function usefulLines(lines: string[]) {
  const ignored = [
    /^飞书智能纪要 AI 文档$/u,
    /^[A-Za-z0-9]{20,64}$/u,
    /^\{.*(?:feishu\.cn|minute_token).*\}$/iu,
    /^智能纪要[：:]/u,
    /^会议(?:主题|时间|地点)[：:]/u,
    /^参会人[：:]/u,
    /^智能会议纪要由 AI 生成/u,
    /^总结$/u,
    /^本次会议.+内容如下[：:]?$/u,
    /^(?:科研|研究)工作进展汇报$/u,
    /^meetgraph\//iu,
    /^相关链接$/u,
    /^文字记录$/u,
  ];
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !ignored.some((pattern) => pattern.test(line)));
}

function researchLines(text: string) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim());
  const start = lines.findIndex((line) => /(?:科研|研究|实验|算法|论文|文稿).*(?:进展|汇报)/u.test(line));
  const from = start >= 0 ? start + 1 : 0;
  const relativeEnd = lines.slice(from).findIndex((line) =>
    /^(?:课题组|实验室|行政|团队)(?:事务|管理|建设)|^其他事项|^待办$|^相关链接$/u.test(line),
  );
  const to = relativeEnd >= 0 ? from + relativeEnd : lines.length;
  return usefulLines(lines.slice(from, to));
}

function progressTitle(lines: string[]) {
  const labeled = lines.find((line) => {
    const [label, detail] = line.split(/[：:]/u, 2);
    return Boolean(label && detail && label.length <= 28 && /完成|验证|得到|形成|选定|提升|优化|发现|排除/u.test(detail));
  });
  if (labeled) return `组会进展：${labeled.split(/[：:]/u, 1)[0].trim()}`.slice(0, 160);
  const first = lines.find((line) => line.length >= 8) ?? "科研工作更新";
  return `组会进展：${first.replace(/[：:].*$/u, "").slice(0, 40)}`.slice(0, 160);
}

function makeDraft(student: ProgressStudent, lines: string[]): StudentProgressDraft | null {
  const cleaned = usefulLines(lines);
  const summary = cleaned.join("\n").trim().slice(0, 12_000);
  if (summary.length < 24) return null;
  return {
    studentId: student.id,
    studentName: student.displayName,
    title: progressTitle(cleaned),
    summary,
  };
}

export function splitMeetingProgressByStudent(text: string, students: ProgressStudent[]) {
  const activeStudents = students.filter((student) => student.displayName && containsStudentName(text, student.displayName));
  if (!activeStudents.length) return [];

  const lines = researchLines(text);
  if (!lines.length) return [];
  const headings = lines.flatMap((line, index) => {
    const student = studentHeading(line, activeStudents);
    return student ? [{ index, student }] : [];
  });

  if (headings.length) {
    const grouped = new Map<string, { student: ProgressStudent; lines: string[] }>();
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      const end = headings[index + 1]?.index ?? lines.length;
      const firstLine = stripStudentHeading(lines[heading.index], heading.student.displayName);
      const section = [firstLine, ...lines.slice(heading.index + 1, end)].filter(Boolean);
      const current = grouped.get(heading.student.id) ?? { student: heading.student, lines: [] };
      current.lines.push(...section);
      grouped.set(heading.student.id, current);
    }
    return Array.from(grouped.values()).flatMap(({ student, lines: studentLines }) => {
      const draft = makeDraft(student, studentLines);
      return draft ? [draft] : [];
    });
  }

  if (activeStudents.length !== 1) return [];
  const draft = makeDraft(activeStudents[0], lines);
  return draft ? [draft] : [];
}
