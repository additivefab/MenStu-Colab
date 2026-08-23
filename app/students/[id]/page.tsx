import type { Metadata } from "next";

import StudentOverview from "./student-overview";

export const metadata: Metadata = {
  title: "学生科研前景速览｜探研",
  description: "用论文、项目、培养节点和可核验证据快速判断学生当前科研推进态势",
  openGraph: { images: [] },
  twitter: { images: [] },
};

export default async function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudentOverview studentId={id} />;
}
