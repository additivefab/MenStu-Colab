import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const students = sqliteTable("students", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  degree: text("degree", { enum: ["博士", "硕士"] }).notNull(),
  gradeYear: integer("grade_year").notNull(),
  stage: text("stage").notNull(),
  cadenceDays: integer("cadence_days").notNull().default(30),
  currentFocus: text("current_focus").notNull().default(""),
  lastSubstantiveAt: text("last_substantive_at"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const progressEntries = sqliteTable(
  "progress_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    evidence: text("evidence").notNull().default(""),
    literatureRef: text("literature_ref").notNull().default(""),
    gitUrl: text("git_url").notNull().default(""),
    submittedAt: text("submitted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    status: text("status", {
      enum: ["pending", "substantive", "supporting", "supplement", "rejected"],
    })
      .notNull()
      .default("pending"),
    reviewerNote: text("reviewer_note").notNull().default(""),
    reviewedAt: text("reviewed_at"),
  },
  (table) => [
    index("idx_progress_student_submitted").on(table.studentId, table.submittedAt),
    index("idx_progress_status").on(table.status, table.submittedAt),
  ],
);
