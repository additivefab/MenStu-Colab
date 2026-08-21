import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const students = sqliteTable("students", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  degree: text("degree", { enum: ["博士", "硕士"] }).notNull(),
  gradeYear: integer("grade_year").notNull(),
  stage: text("stage").notNull(),
  cadenceDays: integer("cadence_days").notNull().default(30),
  currentFocus: text("current_focus").notNull().default(""),
  lastSubstantiveAt: text("last_substantive_at"),
  trackingStartedAt: text("tracking_started_at"),
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

export const appUsers = sqliteTable(
  "app_users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    feishuOpenId: text("feishu_open_id").notNull(),
    feishuUnionId: text("feishu_union_id").notNull().default(""),
    feishuUserId: text("feishu_user_id").notNull().default(""),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url").notNull().default(""),
    email: text("email").notNull().default(""),
    role: text("role", { enum: ["admin", "student", "pending"] })
      .notNull()
      .default("pending"),
    studentId: text("student_id").references(() => students.id),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastLoginAt: text("last_login_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_app_users_feishu_open_id").on(table.feishuOpenId),
    index("idx_app_users_role").on(table.role),
    uniqueIndex("idx_app_users_student_id_unique").on(table.studentId),
  ],
);

export const appSessions = sqliteTable(
  "app_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    appUserId: integer("app_user_id")
      .notNull()
      .references(() => appUsers.id),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_app_sessions_user").on(table.appUserId),
    index("idx_app_sessions_expires").on(table.expiresAt),
  ],
);
