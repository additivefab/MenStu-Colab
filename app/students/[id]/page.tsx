import type { Metadata } from "next";

import StudentOverview from "./student-overview";

export const metadata: Metadata = {
  title: "学生科研全景｜探研",
  description: "学生研究方案、培养节点、个人进展、审核与风险状态全景页",
  openGraph: { images: [] },
  twitter: { images: [] },
};

export default async function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudentOverview studentId={id} />;
}
