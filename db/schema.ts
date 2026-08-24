import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const appSchemaMeta = sqliteTable(
  "app_schema_meta",
  {
    id: integer("id").primaryKey(),
    version: integer("version").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [check("app_schema_meta_singleton", sql`${table.id} = 1`)],
);

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
    reviewStatus: text("review_status", {
      enum: ["submitted", "in_review", "accepted", "changes_requested", "rejected"],
    })
      .notNull()
      .default("submitted"),
    assessment: text("assessment", { enum: ["substantive", "supporting"] }),
    submittedByUserId: integer("submitted_by_user_id"),
    reviewedByUserId: integer("reviewed_by_user_id"),
    reviewClaimedAt: text("review_claimed_at"),
    reviewerNote: text("reviewer_note").notNull().default(""),
    reviewedAt: text("reviewed_at"),
    currentRevision: integer("current_revision").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull().default(""),
    requestHash: text("request_hash").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_progress_student_submitted").on(table.studentId, table.submittedAt),
    index("idx_progress_status").on(table.status, table.submittedAt),
    index("idx_progress_review_status").on(table.reviewStatus, table.submittedAt),
    index("idx_progress_reviewer").on(table.reviewedByUserId, table.reviewStatus),
    uniqueIndex("idx_progress_submitter_idempotency")
      .on(table.submittedByUserId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} <> ''`),
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
    // `mentor` remains an internal storage value for rollback-safe scoped admins.
    role: text("role", { enum: ["superadmin", "admin", "mentor", "student", "pending"] })
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

export const mentorStudentAssignments = sqliteTable(
  "mentor_student_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mentorUserId: integer("mentor_user_id")
      .notNull()
      .references(() => appUsers.id),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    relationship: text("relationship", { enum: ["primary", "co"] })
      .notNull()
      .default("primary"),
    canReview: integer("can_review", { mode: "boolean" }).notNull().default(true),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_mentor_student_unique").on(table.mentorUserId, table.studentId),
    index("idx_mentor_active_students").on(table.mentorUserId, table.active, table.studentId),
    index("idx_student_active_mentors").on(table.studentId, table.active, table.mentorUserId),
  ],
);

export const studentGuidanceNotes = sqliteTable(
  "student_guidance_notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    mentorUserId: integer("mentor_user_id")
      .notNull()
      .references(() => appUsers.id),
    sourceProgressEntryId: integer("source_progress_entry_id")
      .references(() => progressEntries.id),
    guidanceType: text("guidance_type", {
      enum: ["meeting_followup", "paper", "milestone", "blocker", "general"],
    })
      .notNull()
      .default("general"),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
    nextAction: text("next_action").notNull().default(""),
    dueDate: text("due_date"),
    acceptanceCriteria: text("acceptance_criteria").notNull().default(""),
    verificationMode: text("verification_mode", { enum: ["self_report", "mentor_verify"] })
      .notNull()
      .default("mentor_verify"),
    status: text("status", { enum: ["open", "completed"] })
      .notNull()
      .default("open"),
    acknowledgedAt: text("acknowledged_at"),
    studentReportedAt: text("student_reported_at"),
    mentorVerifiedAt: text("mentor_verified_at"),
    completedAt: text("completed_at"),
    completedByUserId: integer("completed_by_user_id")
      .references(() => appUsers.id),
    completionNote: text("completion_note").notNull().default(""),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("student_guidance_notes_type_check", sql`${table.guidanceType} IN ('meeting_followup', 'paper', 'milestone', 'blocker', 'general')`),
    check("student_guidance_notes_status_check", sql`${table.status} IN ('open', 'completed')`),
    check("student_guidance_notes_verification_check", sql`${table.verificationMode} IN ('self_report', 'mentor_verify')`),
    check("student_guidance_notes_version_check", sql`${table.version} >= 1`),
    index("idx_student_guidance_student_created").on(table.studentId, table.createdAt),
    index("idx_student_guidance_mentor_created").on(table.mentorUserId, table.createdAt),
    index("idx_student_guidance_source").on(table.sourceProgressEntryId),
  ],
);

export const studentGuidanceEvents = sqliteTable(
  "student_guidance_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    guidanceNoteId: integer("guidance_note_id")
      .notNull()
      .references(() => studentGuidanceNotes.id),
    actorUserId: integer("actor_user_id").references(() => appUsers.id),
    actorType: text("actor_type", { enum: ["staff", "student", "system"] }).notNull(),
    action: text("action", { enum: ["created", "acknowledged", "completed", "reopened"] }).notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("student_guidance_events_actor_type", sql`${table.actorType} IN ('staff', 'student', 'system')`),
    check("student_guidance_events_action", sql`${table.action} IN ('created', 'acknowledged', 'completed', 'reopened')`),
    index("idx_student_guidance_events_note_created").on(table.guidanceNoteId, table.createdAt),
  ],
);

export const appUserRoleEvents = sqliteTable(
  "app_user_role_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    targetUserId: integer("target_user_id")
      .notNull()
      .references(() => appUsers.id),
    actorUserId: integer("actor_user_id")
      .notNull()
      .references(() => appUsers.id),
    requestId: text("request_id").notNull(),
    fromRole: text("from_role").notNull(),
    toRole: text("to_role").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_app_user_role_events_request").on(table.requestId),
    index("idx_app_user_role_events_target").on(table.targetUserId, table.createdAt),
    index("idx_app_user_role_events_actor").on(table.actorUserId, table.createdAt),
  ],
);

export const studentIdentityBindingBatches = sqliteTable(
  "student_identity_binding_batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorUserId: integer("actor_user_id").notNull().references(() => appUsers.id),
    requestId: text("request_id").notNull(),
    recordCount: integer("record_count").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_student_identity_binding_batches_request").on(table.requestId),
    check("student_identity_binding_batches_record_count", sql`${table.recordCount} = 26`),
  ],
);

export const studentFeishuIdentityBindings = sqliteTable(
  "student_feishu_identity_bindings",
  {
    studentId: text("student_id").primaryKey().references(() => students.id),
    feishuOpenId: text("feishu_open_id").notNull(),
    batchId: integer("batch_id").notNull().references(() => studentIdentityBindingBatches.id),
    verifiedByUserId: integer("verified_by_user_id").notNull().references(() => appUsers.id),
    verificationMethod: text("verification_method").notNull().default("feishu_contact_batch_get_id"),
    contactKind: text("contact_kind", { enum: ["email", "mobile", "existing_login"] }).notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_student_identity_bindings_open_id").on(table.feishuOpenId),
    index("idx_student_identity_bindings_batch").on(table.batchId),
    check("student_identity_bindings_contact_kind", sql`${table.contactKind} IN ('email', 'mobile', 'existing_login')`),
  ],
);

export const meetingRequests = sqliteTable(
  "meeting_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    requestedByUserId: integer("requested_by_user_id")
      .notNull()
      .references(() => appUsers.id),
    preferredDate: text("preferred_date").notNull(),
    preferredTime: text("preferred_time").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    topic: text("topic").notNull(),
    note: text("note").notNull().default(""),
    status: text("status", {
      enum: ["requested", "confirmed", "declined", "cancelled"],
    })
      .notNull()
      .default("requested"),
    handledByUserId: integer("handled_by_user_id").references(() => appUsers.id),
    responseNote: text("response_note").notNull().default(""),
    handledAt: text("handled_at"),
    version: integer("version").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull().default(""),
    requestHash: text("request_hash").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "meeting_requests_duration_check",
      sql`${table.durationMinutes} IN (15, 30, 45, 60)`,
    ),
    check(
      "meeting_requests_status_check",
      sql`${table.status} IN ('requested', 'confirmed', 'declined', 'cancelled')`,
    ),
    check("meeting_requests_version_check", sql`${table.version} >= 1`),
    index("idx_meeting_requests_student_created").on(table.studentId, table.createdAt),
    index("idx_meeting_requests_requester_created").on(
      table.requestedByUserId,
      table.createdAt,
    ),
    index("idx_meeting_requests_status_schedule").on(
      table.status,
      table.preferredDate,
      table.preferredTime,
    ),
    uniqueIndex("idx_meeting_requester_idempotency")
      .on(table.requestedByUserId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} <> ''`),
  ],
);

export const meetingAgendas = sqliteTable(
  "meeting_agendas",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mentorUserId: integer("mentor_user_id")
      .notNull()
      .references(() => appUsers.id),
    title: text("title").notNull(),
    meetingDate: text("meeting_date"),
    status: text("status", { enum: ["draft", "scheduled", "completed", "cancelled"] })
      .notNull()
      .default("draft"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("meeting_agendas_status_check", sql`${table.status} IN ('draft', 'scheduled', 'completed', 'cancelled')`),
    index("idx_meeting_agendas_mentor_updated").on(table.mentorUserId, table.updatedAt),
    index("idx_meeting_agendas_status_date").on(table.status, table.meetingDate),
  ],
);

export const meetingAgendaItems = sqliteTable(
  "meeting_agenda_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agendaId: integer("agenda_id")
      .notNull()
      .references(() => meetingAgendas.id),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    topic: text("topic").notNull(),
    reason: text("reason").notNull().default(""),
    durationMinutes: integer("duration_minutes").notNull().default(10),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_meeting_agenda_items_agenda_order").on(table.agendaId, table.sortOrder),
    index("idx_meeting_agenda_items_student_status").on(table.studentId, table.status),
    check("meeting_agenda_items_status_check", sql`${table.status} IN ('open', 'resolved')`),
    check("meeting_agenda_items_duration_check", sql`${table.durationMinutes} IN (5, 10, 15, 20, 30)`),
  ],
);

export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    triggeredByUserId: integer("triggered_by_user_id")
      .notNull()
      .references(() => appUsers.id),
    notificationType: text("notification_type", { enum: ["progress_reminder"] })
      .notNull()
      .default("progress_reminder"),
    reason: text("reason").notNull().default(""),
    idempotencyKey: text("idempotency_key").notNull(),
    attemptToken: text("attempt_token").notNull().default(""),
    status: text("status", { enum: ["sending", "sent", "failed"] }).notNull().default("sending"),
    errorMessage: text("error_message").notNull().default(""),
    providerMessageId: text("provider_message_id").notNull().default(""),
    sentAt: text("sent_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("notification_deliveries_type_check", sql`${table.notificationType} IN ('progress_reminder')`),
    check("notification_deliveries_status_check", sql`${table.status} IN ('sending', 'sent', 'failed')`),
    uniqueIndex("idx_notification_deliveries_idempotency").on(table.idempotencyKey),
    index("idx_notification_deliveries_student_created").on(table.studentId, table.createdAt),
    index("idx_notification_deliveries_status_created").on(table.status, table.createdAt),
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

export const progressAuditEvents = sqliteTable(
  "progress_audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    progressEntryId: integer("progress_entry_id")
      .notNull()
      .references(() => progressEntries.id),
    actorUserId: integer("actor_user_id").references(() => appUsers.id),
    actorType: text("actor_type", { enum: ["user", "system", "feishu", "legacy"] })
      .notNull()
      .default("user"),
    action: text("action").notNull(),
    fromStatus: text("from_status").notNull().default(""),
    toStatus: text("to_status").notNull().default(""),
    assessment: text("assessment").notNull().default(""),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_progress_audit_entry_created").on(table.progressEntryId, table.createdAt)],
);

export const progressAttachments = sqliteTable(
  "progress_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    progressEntryId: integer("progress_entry_id")
      .notNull()
      .references(() => progressEntries.id),
    storageKey: text("storage_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull().default("application/octet-stream"),
    sizeBytes: integer("size_bytes").notNull(),
    contentSha256: text("content_sha256").notNull(),
    revisionNumber: integer("revision_number").notNull().default(1),
    uploadedByUserId: integer("uploaded_by_user_id")
      .notNull()
      .references(() => appUsers.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_progress_attachments_storage_key").on(table.storageKey),
    index("idx_progress_attachments_entry_created").on(table.progressEntryId, table.createdAt),
    index("idx_progress_attachments_entry_revision").on(table.progressEntryId, table.revisionNumber),
  ],
);

export const progressFileCleanupQueue = sqliteTable(
  "progress_file_cleanup_queue",
  {
    storageKey: text("storage_key").primaryKey(),
    progressEntryId: integer("progress_entry_id").references(() => progressEntries.id, { onDelete: "set null" }),
    studentId: text("student_id").notNull(),
    revisionNumber: integer("revision_number").notNull().default(1),
    reason: text("reason").notNull().default("compensation_failed"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_progress_cleanup_updated").on(table.updatedAt),
    index("idx_progress_cleanup_entry").on(table.progressEntryId),
  ],
);

export const progressRevisions = sqliteTable(
  "progress_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    progressEntryId: integer("progress_entry_id").notNull().references(() => progressEntries.id),
    revisionNumber: integer("revision_number").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    submittedByUserId: integer("submitted_by_user_id").references(() => appUsers.id),
    reviewStatus: text("review_status", {
      enum: ["submitted", "in_review", "accepted", "changes_requested", "rejected"],
    }).notNull().default("submitted"),
    assessment: text("assessment", { enum: ["substantive", "supporting"] }),
    reviewerNote: text("reviewer_note").notNull().default(""),
    reviewedByUserId: integer("reviewed_by_user_id").references(() => appUsers.id),
    reviewedAt: text("reviewed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_progress_revisions_entry_number").on(table.progressEntryId, table.revisionNumber),
    index("idx_progress_revisions_entry_created").on(table.progressEntryId, table.createdAt),
  ],
);

export const studentPapers = sqliteTable(
  "student_papers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    title: text("title").notNull(),
    paperType: text("paper_type", { enum: ["期刊论文", "会议论文", "学位论文"] })
      .notNull()
      .default("期刊论文"),
    targetVenue: text("target_venue").notNull().default(""),
    plannedSubmissionDate: text("planned_submission_date"),
    currentStage: text("current_stage", {
      enum: ["planning", "research", "drafting", "internal_review", "submitted", "peer_review", "revision", "accepted", "published"],
    })
      .notNull()
      .default("planning"),
    submissionIdentifier: text("submission_identifier").notNull().default(""),
    status: text("status", { enum: ["active", "on_hold", "accepted", "published", "closed"] })
      .notNull()
      .default("active"),
    latestProgressAt: text("latest_progress_at"),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => appUsers.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_student_papers_student_status").on(table.studentId, table.status, table.updatedAt),
    index("idx_student_papers_stage_due").on(table.currentStage, table.plannedSubmissionDate),
  ],
);

export const paperSubmissionCandidates = sqliteTable(
  "paper_submission_candidates",
  {
    progressEntryId: integer("progress_entry_id")
      .primaryKey()
      .references(() => progressEntries.id),
    title: text("title").notNull(),
    paperType: text("paper_type", { enum: ["期刊论文", "会议论文", "学位论文"] }).notNull(),
    targetVenue: text("target_venue").notNull().default(""),
    plannedSubmissionDate: text("planned_submission_date").notNull(),
    stage: text("stage", {
      enum: ["planning", "research", "drafting", "internal_review", "submitted", "peer_review", "revision", "accepted", "published"],
    }).notNull(),
    manuscriptVersion: text("manuscript_version").notNull().default(""),
    nextAction: text("next_action").notNull(),
    nextActionDueDate: text("next_action_due_date").notNull(),
    blocker: text("blocker").notNull().default(""),
    submissionIdentifier: text("submission_identifier").notNull().default(""),
    promotedPaperId: integer("promoted_paper_id").references(() => studentPapers.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_paper_candidates_promoted").on(table.promotedPaperId),
  ],
);

export const paperProgressDetails = sqliteTable(
  "paper_progress_details",
  {
    progressEntryId: integer("progress_entry_id")
      .primaryKey()
      .references(() => progressEntries.id),
    paperId: integer("paper_id")
      .notNull()
      .references(() => studentPapers.id),
    stage: text("stage", {
      enum: ["planning", "research", "drafting", "internal_review", "submitted", "peer_review", "revision", "accepted", "published"],
    }).notNull(),
    manuscriptVersion: text("manuscript_version").notNull().default(""),
    nextAction: text("next_action").notNull(),
    nextActionDueDate: text("next_action_due_date").notNull(),
    blocker: text("blocker").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_paper_progress_paper_created").on(table.paperId, table.createdAt),
    index("idx_paper_progress_due").on(table.nextActionDueDate, table.stage),
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
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_research_milestones_proposal_order").on(table.proposalId, table.sortOrder)],
);

export const projectProgressDetails = sqliteTable(
  "project_progress_details",
  {
    progressEntryId: integer("progress_entry_id")
      .primaryKey()
      .references(() => progressEntries.id),
    milestoneId: integer("milestone_id").references(() => researchMilestones.id),
    milestoneTitle: text("milestone_title").notNull().default(""),
    milestoneTargetDate: text("milestone_target_date"),
    evidenceTarget: text("evidence_target").notNull().default(""),
    proposalVersion: integer("proposal_version"),
    nextAction: text("next_action").notNull(),
    nextActionDueDate: text("next_action_due_date").notNull(),
    blocker: text("blocker").notNull().default(""),
    completionRequested: integer("completion_requested", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_project_progress_milestone_created").on(table.milestoneId, table.createdAt),
    index("idx_project_progress_due").on(table.nextActionDueDate),
    check("project_progress_completion_requested", sql`${table.completionRequested} IN (0, 1)`),
  ],
);

export const researchOutputs = sqliteTable(
  "research_outputs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    studentId: text("student_id")
      .notNull()
      .references(() => students.id),
    outputType: text("output_type", {
      enum: ["paper", "dataset", "software", "patent", "report", "presentation", "other"],
    }).notNull(),
    title: text("title").notNull(),
    lifecycleStatus: text("lifecycle_status", {
      enum: ["planned", "in_progress", "submitted", "accepted", "published", "archived"],
    })
      .notNull()
      .default("planned"),
    venue: text("venue").notNull().default(""),
    identifier: text("identifier").notNull().default(""),
    url: text("url").notNull().default(""),
    summary: text("summary").notNull().default(""),
    linkedMilestoneId: integer("linked_milestone_id").references(() => researchMilestones.id),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => appUsers.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_research_outputs_student_updated").on(table.studentId, table.updatedAt),
    index("idx_research_outputs_status").on(table.lifecycleStatus, table.updatedAt),
  ],
);

export const researchOutputEvents = sqliteTable(
  "research_output_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    outputId: integer("output_id")
      .notNull()
      .references(() => researchOutputs.id),
    actorUserId: integer("actor_user_id")
      .notNull()
      .references(() => appUsers.id),
    action: text("action").notNull(),
    detail: text("detail").notNull().default(""),
    snapshotJson: text("snapshot_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_research_output_events_output").on(table.outputId, table.createdAt)],
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

export const progressEvidenceSources = sqliteTable(
  "progress_evidence_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    progressEntryId: integer("progress_entry_id")
      .notNull()
      .references(() => progressEntries.id),
    sourceType: text("source_type", {
      enum: ["manual", "feishu_docx", "feishu_minutes", "feishu_message", "git", "doi", "url", "external"],
    }).notNull(),
    label: text("label").notNull(),
    sourceRef: text("source_ref").notNull().default(""),
    sourceImportId: integer("source_import_id").references(() => feishuMeetingSummaryImports.id),
    contentSha256: text("content_sha256").notNull().default(""),
    revisionNumber: integer("revision_number").notNull().default(1),
    occurredAt: text("occurred_at"),
    createdByUserId: integer("created_by_user_id").references(() => appUsers.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_progress_evidence_entry").on(table.progressEntryId, table.createdAt),
    index("idx_progress_evidence_entry_revision").on(table.progressEntryId, table.revisionNumber),
    index("idx_progress_evidence_import").on(table.sourceImportId),
  ],
);
