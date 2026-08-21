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

export const researchProposals = sqliteTable(
  "research_proposals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    title: text("title").notNull().default("未命名方案"),
    scientificQuestion: text("scientific_question").notNull().default(""),
    hypothesis: text("hypothesis").notNull().default(""),
    objectives: text("objectives").notNull().default(""),
    innovation: text("innovation").notNull().default(""),
    literatureBasis: text("literature_basis").notNull().default(""),
    methodology: text("methodology").notNull().default(""),
    dataEthics: text("data_ethics").notNull().default(""),
    risks: text("risks").notNull().default(""),
    resources: text("resources").notNull().default(""),
    referencesText: text("references_text").notNull().default(""),
    status: text("status", {
      enum: ["draft", "submitted", "changes_requested", "approved"],
    })
      .notNull()
      .default("draft"),
    currentVersion: integer("current_version").notNull().default(0),
    reviewerNote: text("reviewer_note").notNull().default(""),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => appUsers.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    submittedAt: text("submitted_at"),
    approvedAt: text("approved_at"),
  },
  (table) => [
    uniqueIndex("idx_research_proposals_student_unique").on(table.studentId),
    index("idx_research_proposals_status_updated").on(table.status, table.updatedAt),
  ],
);

export const researchProposalVersions = sqliteTable(
  "research_proposal_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    proposalId: integer("proposal_id")
      .notNull()
      .references(() => researchProposals.id),
    versionNumber: integer("version_number").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    submittedByUserId: integer("submitted_by_user_id")
      .notNull()
      .references(() => appUsers.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_proposal_versions_proposal_number").on(table.proposalId, table.versionNumber),
    index("idx_proposal_versions_created").on(table.proposalId, table.createdAt),
  ],
);

export const researchMilestones = sqliteTable(
  "research_milestones",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    proposalId: integer("proposal_id")
      .notNull()
      .references(() => researchProposals.id),
    title: text("title").notNull(),
    targetDate: text("target_date").notNull(),
    evidenceTarget: text("evidence_target").notNull().default(""),
    status: text("status", {
      enum: ["pending", "in_progress", "completed", "blocked"],
    })
      .notNull()
      .default("pending"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_research_milestones_proposal_order").on(table.proposalId, table.sortOrder)],
);

export const proposalAuditEvents = sqliteTable(
  "proposal_audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    proposalId: integer("proposal_id")
      .notNull()
      .references(() => researchProposals.id),
    actorUserId: integer("actor_user_id")
      .notNull()
      .references(() => appUsers.id),
    action: text("action").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_proposal_audit_proposal_created").on(table.proposalId, table.createdAt)],
);

export const feishuMeetingSummaryImports = sqliteTable(
  "feishu_meeting_summary_imports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    messageId: text("message_id").notNull(),
    chatId: text("chat_id").notNull(),
    senderId: text("sender_id").notNull().default(""),
    senderType: text("sender_type").notNull().default(""),
    messageType: text("message_type").notNull().default(""),
    rawContent: text("raw_content").notNull(),
    extractedText: text("extracted_text").notNull(),
    detectedReason: text("detected_reason").notNull().default(""),
    status: text("status", { enum: ["pending", "confirmed", "ignored"] })
      .notNull()
      .default("pending"),
    messageCreatedAt: text("message_created_at").notNull(),
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    reviewedByUserId: integer("reviewed_by_user_id").references(() => appUsers.id),
    reviewedAt: text("reviewed_at"),
  },
  (table) => [
    uniqueIndex("idx_feishu_summary_event_unique").on(table.eventId),
    uniqueIndex("idx_feishu_summary_message_unique").on(table.messageId),
    index("idx_feishu_summary_status_received").on(table.status, table.receivedAt),
  ],
);

export const feishuMeetingSummaryLinks = sqliteTable(
  "feishu_meeting_summary_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importId: integer("import_id")
      .notNull()
      .references(() => feishuMeetingSummaryImports.id),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    progressEntryId: integer("progress_entry_id")
      .notNull()
      .references(() => progressEntries.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_feishu_summary_link_import_student").on(table.importId, table.studentId),
    index("idx_feishu_summary_link_student").on(table.studentId, table.createdAt),
  ],
);
