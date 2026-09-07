import type { Metadata } from "next";

import StudentOverview from "./student-overview";

export const metadata: Metadata = {
  title: "学生档案｜探研",
  description: "查看学生的论文、课题、培养进度和提交材料",
  openGraph: { images: [] },
  twitter: { images: [] },
};

export default async function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StudentOverview studentId={id} />;
}
