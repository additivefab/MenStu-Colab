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

export const studentRepositoryBindings = sqliteTable("student_repository_bindings", {
  studentId: text("student_id").primaryKey().references(() => students.id),
  githubUsername: text("github_username").notNull(),
  repositoryUrl: text("repository_url").notNull(),
  repositoryFullName: text("repository_full_name").notNull(),
  visibility: text("visibility", { enum: ["private", "public", "unknown"] }).notNull().default("unknown"),
  active: integer("active").notNull().default(1),
  version: integer("version").notNull().default(1),
  lastMutationId: text("last_mutation_id").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => appUsers.id),
  updatedByUserId: integer("updated_by_user_id").references(() => appUsers.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("student_repository_visibility", sql`${table.visibility} IN ('private', 'public', 'unknown')`),
  check("student_repository_active", sql`${table.active} IN (0, 1)`),
  check("student_repository_version", sql`${table.version} >= 1`),
  uniqueIndex("idx_student_repository_mutation").on(table.lastMutationId),
]);

export const studentRepositoryEvents = sqliteTable("student_repository_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  studentId: text("student_id").notNull().references(() => students.id),
  version: integer("version").notNull(),
  action: text("action", { enum: ["created", "updated", "unlinked"] }).notNull(),
  actorUserId: integer("actor_user_id").references(() => appUsers.id),
  actorType: text("actor_type", { enum: ["user", "system"] }).notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("student_repository_event_action", sql`${table.action} IN ('created', 'updated', 'unlinked')`),
  check("student_repository_event_actor", sql`${table.actorType} IN ('user', 'system')`),
  check("student_repository_event_version", sql`${table.version} >= 1`),
  uniqueIndex("idx_student_repository_event_version").on(table.studentId, table.version),
]);

export const studentRepositoryRollouts = sqliteTable("student_repository_rollouts", {
  rolloutKey: text("rollout_key").primaryKey(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

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
    authMethod: text("auth_method").notNull().default("feishu"),
    localCredentialVersion: integer("local_credential_version"),
    localStudentId: text("local_student_id"),
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
    submissionStatus: text("submission_status").notNull().default("not_submitted"),
    submissionUrl: text("submission_url").notNull().default(""),
    submissionUsername: text("submission_username").notNull().default(""),
    submissionPasswordCiphertext: text("submission_password_ciphertext"),
    submissionPasswordIv: text("submission_password_iv"),
    submissionNextAction: text("submission_next_action").notNull().default(""),
    submissionNextActionDueDate: text("submission_next_action_due_date"),
    patentApplicationNumber: text("patent_application_number").notNull().default(""),
    patentApplicationDate: text("patent_application_date"),
    patentOffice: text("patent_office").notNull().default(""),
    patentReviewStage: text("patent_review_stage").notNull().default(""),
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

export const researchOutputGuidanceLinks = sqliteTable(
  "research_output_guidance_links",
  {
    guidanceNoteId: integer("guidance_note_id")
      .primaryKey()
      .references(() => studentGuidanceNotes.id),
    outputId: integer("research_output_id")
      .notNull()
      .references(() => researchOutputs.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_research_output_guidance_output").on(table.outputId, table.createdAt)],
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

export const progressDeletions = sqliteTable("progress_deletions", {
  progressEntryId: integer("progress_entry_id").primaryKey().references(() => progressEntries.id),
  deletedByUserId: integer("deleted_by_user_id").notNull().references(() => appUsers.id),
  deletedAt: text("deleted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  operationId: text("operation_id").notNull(),
});

export const progressResolutions = sqliteTable("progress_resolutions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  studentId: text("student_id").notNull().references(() => students.id),
  progressEntryId: integer("progress_entry_id").notNull().references(() => progressEntries.id),
  revisionNumber: integer("revision_number").notNull(),
  itemKind: text("item_kind", { enum: ["blocker", "next_action"] }).notNull(),
  sourceTitle: text("source_title").notNull(),
  sourceText: text("source_text").notNull(),
  sourceDueDate: text("source_due_date"),
  trackType: text("track_type", { enum: ["paper", "project"] }).notNull(),
  status: text("status", { enum: ["open", "pending", "resolved", "changes_requested"] }).notNull().default("open"),
  version: integer("version").notNull().default(1),
  submissionNote: text("submission_note").notNull().default(""),
  reviewerNote: text("reviewer_note").notNull().default(""),
  submittedByUserId: integer("submitted_by_user_id").references(() => appUsers.id),
  submittedAt: text("submitted_at"),
  resolvedAt: text("resolved_at"),
  lastRequestId: text("last_request_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_progress_resolutions_source").on(table.progressEntryId, table.revisionNumber, table.itemKind),
  index("idx_progress_resolutions_student_status").on(table.studentId, table.status),
  check("progress_resolutions_kind", sql`${table.itemKind} IN ('blocker', 'next_action')`),
  check("progress_resolutions_status", sql`${table.status} IN ('open', 'pending', 'resolved', 'changes_requested')`),
  check("progress_resolutions_version", sql`${table.version} >= 1 AND ${table.revisionNumber} >= 1`),
]);

export const progressResolutionEvents = sqliteTable("progress_resolution_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  resolutionId: integer("resolution_id").notNull().references(() => progressResolutions.id),
  actorUserId: integer("actor_user_id").notNull().references(() => appUsers.id),
  action: text("action", { enum: ["submit", "confirm", "request_changes", "reopen"] }).notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  version: integer("version").notNull(),
  note: text("note").notNull().default(""),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_resolution_events_request").on(table.actorUserId, table.requestId),
  uniqueIndex("idx_resolution_events_version").on(table.resolutionId, table.version),
  check("progress_resolution_events_action", sql`${table.action} IN ('submit', 'confirm', 'request_changes', 'reopen')`),
]);

export const progressResolutionAttachments = sqliteTable("progress_resolution_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventId: integer("event_id").notNull().references(() => progressResolutionEvents.id),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  contentSha256: text("content_sha256").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_resolution_attachments_storage").on(table.storageKey),
  index("idx_resolution_attachments_event").on(table.eventId),
]);

export const localCredentials = sqliteTable("local_credentials", {
  appUserId: integer("app_user_id").primaryKey().references(() => appUsers.id),
  studentId: text("student_id").references(() => students.id),
  authorizedRole: text("authorized_role").notNull().default("student"),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash"),
  mustChangePassword: integer("must_change_password").notNull().default(0),
  activationHash: text("activation_hash").unique(),
  activationExpiresAt: text("activation_expires_at"),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("local_credentials_version", sql`${table.version} >= 1`),
  check("local_credentials_role", sql`${table.authorizedRole} IN ('student', 'admin', 'superadmin')`),
]);

export const localAuthEvents = sqliteTable("local_auth_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appUserId: integer("app_user_id").notNull().references(() => appUsers.id),
  actorUserId: integer("actor_user_id").notNull().references(() => appUsers.id),
  action: text("action").notNull(),
  requestId: text("request_id").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [check("local_auth_events_action", sql`${table.action} IN ('issue', 'activate', 'disable', 'change_password')`)]);

export const localAuthAttempts = sqliteTable("local_auth_attempts", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  windowStart: integer("window_start").notNull(),
});

export const localLoginRollouts = sqliteTable("local_login_rollouts", {
  rolloutKey: text("rollout_key").primaryKey(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// Schema 26: research loop (task → agent attempt → change request → run →
// result review). Contract: docs/科研闭环_实施规格_v1.md. All tables below are
// created only by Drizzle migration 0026; runtime never invents them.
// ---------------------------------------------------------------------------

const AGENT_PROVIDERS = sql`('codex', 'claude', 'deepseek')`;

export const researchTasks = sqliteTable("research_tasks", {
  id: text("id").primaryKey(),
  studentId: text("student_id").notNull().references(() => students.id),
  sourceGuidanceNoteId: integer("source_guidance_note_id").references(() => studentGuidanceNotes.id),
  sourceRunId: text("source_run_id"),
  parentTaskId: text("parent_task_id"),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  currentVersion: integer("current_version").notNull().default(1),
  confirmedVersion: integer("confirmed_version"),
  createdByUserId: integer("created_by_user_id").notNull().references(() => appUsers.id),
  // Idempotency key of the create request; never overwritten.
  createMutationId: text("create_mutation_id").notNull().unique(),
  // Latest mutation marker, also used to guard multi-statement batches.
  lastMutationId: text("last_mutation_id").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("research_task_status", sql`${table.status} IN ('draft', 'confirmed', 'closed', 'canceled')`),
  check("research_task_version", sql`${table.currentVersion} >= 1`),
  index("idx_research_tasks_student").on(table.studentId, table.updatedAt),
]);

export const researchTaskVersions = sqliteTable("research_task_versions", {
  taskId: text("task_id").notNull().references(() => researchTasks.id),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  researchQuestion: text("research_question").notNull(),
  hypothesis: text("hypothesis").notNull().default(""),
  instructions: text("instructions").notNull(),
  acceptanceCriteria: text("acceptance_criteria").notNull(),
  allowedPathsJson: text("allowed_paths_json").notNull().default("[]"),
  protectedPathsJson: text("protected_paths_json").notNull().default("[]"),
  budgetJson: text("budget_json").notNull().default("{}"),
  snapshotSha256: text("snapshot_sha256").notNull(),
  authorUserId: integer("author_user_id").notNull().references(() => appUsers.id),
  confirmedByUserId: integer("confirmed_by_user_id").references(() => appUsers.id),
  confirmedAt: text("confirmed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_research_task_versions_pk").on(table.taskId, table.version),
  check("research_task_versions_version", sql`${table.version} >= 1`),
]);

export const researchTaskEvents = sqliteTable("research_task_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id").notNull().references(() => researchTasks.id),
  version: integer("version").notNull(),
  action: text("action").notNull(),
  actorType: text("actor_type").notNull(),
  actorUserId: integer("actor_user_id").references(() => appUsers.id),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("research_task_event_action", sql`${table.action} IN ('created', 'revised', 'confirmed', 'closed', 'canceled')`),
  check("research_task_event_actor", sql`${table.actorType} IN ('user', 'system')`),
  index("idx_research_task_events_task").on(table.taskId, table.id),
]);

export const githubInstallations = sqliteTable("github_installations", {
  installationId: integer("installation_id").primaryKey(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  repositorySelection: text("repository_selection").notNull().default("selected"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("github_installation_status", sql`${table.status} IN ('active', 'suspended', 'deleted')`),
  check("github_installation_selection", sql`${table.repositorySelection} IN ('all', 'selected')`),
]);

// Verified GitHub identity for a student's bound repository. Clients never send
// repository IDs; the server resolves them from this row.
export const repositoryLinks = sqliteTable("repository_links", {
  studentId: text("student_id").primaryKey().references(() => students.id),
  githubRepositoryId: integer("github_repository_id").notNull(),
  installationId: integer("installation_id").notNull().references(() => githubInstallations.installationId),
  fullName: text("full_name").notNull(),
  defaultBranch: text("default_branch").notNull(),
  status: text("status").notNull().default("active"),
  verifiedByUserId: integer("verified_by_user_id").references(() => appUsers.id),
  verifiedAt: text("verified_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("repository_link_status", sql`${table.status} IN ('active', 'revoked')`),
  index("idx_repository_links_repository").on(table.githubRepositoryId),
]);

export const githubWebhookDeliveries = sqliteTable("github_webhook_deliveries", {
  deliveryId: text("delivery_id").primaryKey(),
  event: text("event").notNull(),
  action: text("action").notNull().default(""),
  installationId: integer("installation_id"),
  repositoryId: integer("repository_id"),
  payloadSha256: text("payload_sha256").notNull(),
  summaryJson: text("summary_json").notNull().default("{}"),
  origin: text("origin").notNull().default("external"),
  status: text("status").notNull().default("received"),
  error: text("error").notNull().default(""),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  processedAt: text("processed_at"),
}, (table) => [
  check("github_webhook_origin", sql`${table.origin} IN ('external', 'platform_echo')`),
  check("github_webhook_status", sql`${table.status} IN ('received', 'processed', 'ignored', 'failed')`),
  index("idx_github_webhook_status").on(table.status, table.receivedAt),
]);

export const labRunners = sqliteTable("lab_runners", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  kind: text("kind").notNull(),
  tokenSha256: text("token_sha256").notNull().unique(),
  status: text("status").notNull().default("active"),
  lastSeenAt: text("last_seen_at"),
  createdByUserId: integer("created_by_user_id").references(() => appUsers.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("lab_runner_kind", sql`${table.kind} IN ('compute', 'agent')`),
  check("lab_runner_status", sql`${table.status} IN ('active', 'disabled')`),
]);

// Maps a platform user to a subscription credential profile that exists only on
// an agent worker. The platform never stores the credential itself.
export const agentCredentialProfiles = sqliteTable("agent_credential_profiles", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsers.id),
  provider: text("provider").notNull(),
  workerId: text("worker_id").notNull().references(() => labRunners.id),
  active: integer("active").notNull().default(1),
  createdByUserId: integer("created_by_user_id").references(() => appUsers.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("agent_credential_provider", sql`${table.provider} IN ${AGENT_PROVIDERS}`),
  check("agent_credential_active", sql`${table.active} IN (0, 1)`),
  uniqueIndex("idx_agent_credential_user_provider").on(table.userId, table.provider),
]);

export const agentAttempts = sqliteTable("agent_attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => researchTasks.id),
  taskVersion: integer("task_version").notNull(),
  studentId: text("student_id").notNull().references(() => students.id),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull().default(""),
  sdkVersion: text("sdk_version").notNull().default(""),
  credentialProfileId: text("credential_profile_id").notNull().references(() => agentCredentialProfiles.id),
  githubRepositoryId: integer("github_repository_id").notNull(),
  baseCommitSha: text("base_commit_sha").notNull(),
  contextSnapshotSha256: text("context_snapshot_sha256").notNull(),
  status: text("status").notNull().default("queued"),
  workerId: text("worker_id").references(() => labRunners.id),
  leaseEpoch: integer("lease_epoch").notNull().default(0),
  leaseExpiresAt: text("lease_expires_at"),
  heartbeatAt: text("heartbeat_at"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  diffSha256: text("diff_sha256"),
  diffR2Key: text("diff_r2_key"),
  changedPathsJson: text("changed_paths_json").notNull().default("[]"),
  testsJson: text("tests_json").notNull().default("[]"),
  usageJson: text("usage_json").notNull().default("{}"),
  errorCode: text("error_code").notNull().default(""),
  errorMessage: text("error_message").notNull().default(""),
  requestedByUserId: integer("requested_by_user_id").notNull().references(() => appUsers.id),
  cancelRequestedAt: text("cancel_requested_at"),
  cancelRequestedByUserId: integer("cancel_requested_by_user_id").references(() => appUsers.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("agent_attempt_provider", sql`${table.provider} IN ${AGENT_PROVIDERS}`),
  check("agent_attempt_status", sql`${table.status} IN ('queued', 'running', 'waiting_approval', 'change_ready', 'failed', 'cancel_requested', 'canceled')`),
  check("agent_attempt_sha", sql`length(${table.baseCommitSha}) = 40`),
  index("idx_agent_attempts_task").on(table.taskId, table.createdAt),
  index("idx_agent_attempts_queue").on(table.status, table.createdAt),
]);

export const agentAttemptEvents = sqliteTable("agent_attempt_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  attemptId: text("attempt_id").notNull().references(() => agentAttempts.id),
  sequence: integer("sequence").notNull(),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_agent_attempt_events_seq").on(table.attemptId, table.sequence),
]);

export const changeRequests = sqliteTable("change_requests", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => researchTasks.id),
  attemptId: text("attempt_id").notNull().unique().references(() => agentAttempts.id),
  studentId: text("student_id").notNull().references(() => students.id),
  githubRepositoryId: integer("github_repository_id").notNull(),
  baseCommitSha: text("base_commit_sha").notNull(),
  branchName: text("branch_name").notNull(),
  headCommitSha: text("head_commit_sha"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url").notNull().default(""),
  status: text("status").notNull().default("pending_review"),
  requiresExtraReview: integer("requires_extra_review").notNull().default(0),
  extraReviewApprovedByUserId: integer("extra_review_approved_by_user_id").references(() => appUsers.id),
  extraReviewApprovedAt: text("extra_review_approved_at"),
  publishedByUserId: integer("published_by_user_id").references(() => appUsers.id),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("change_request_status", sql`${table.status} IN ('pending_review', 'publishing', 'open', 'merged', 'closed', 'rejected', 'failed')`),
  check("change_request_extra_review", sql`${table.requiresExtraReview} IN (0, 1)`),
  uniqueIndex("idx_change_requests_branch").on(table.githubRepositoryId, table.branchName),
  index("idx_change_requests_pr").on(table.githubRepositoryId, table.prNumber),
]);

export const registeredEntrypoints = sqliteTable("registered_entrypoints", {
  id: text("id").primaryKey(),
  githubRepositoryId: integer("github_repository_id").notNull(),
  name: text("name").notNull(),
  argvJson: text("argv_json").notNull(),
  paramsSchemaJson: text("params_schema_json").notNull().default("{}"),
  imageRef: text("image_ref").notNull(),
  evaluationProtocolSha256: text("evaluation_protocol_sha256").notNull().default(""),
  active: integer("active").notNull().default(1),
  createdByUserId: integer("created_by_user_id").notNull().references(() => appUsers.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("registered_entrypoint_active", sql`${table.active} IN (0, 1)`),
  index("idx_registered_entrypoints_repository").on(table.githubRepositoryId),
]);

export const datasetVersions = sqliteTable("dataset_versions", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  runnerId: text("runner_id").notNull().references(() => labRunners.id),
  manifestSha256: text("manifest_sha256").notNull(),
  splitManifestSha256: text("split_manifest_sha256").notNull().default(""),
  egressPolicyJson: text("egress_policy_json").notNull(),
  active: integer("active").notNull().default(1),
  createdByUserId: integer("created_by_user_id").notNull().references(() => appUsers.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("dataset_version_active", sql`${table.active} IN (0, 1)`),
]);

// Compute permission only: a grant lets a student's approved runs read the
// dataset on the lab runner. It never grants download, copy, or model egress.
export const datasetGrants = sqliteTable("dataset_grants", {
  datasetVersionId: text("dataset_version_id").notNull().references(() => datasetVersions.id),
  studentId: text("student_id").notNull().references(() => students.id),
  grantedByUserId: integer("granted_by_user_id").notNull().references(() => appUsers.id),
  grantedAt: text("granted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedAt: text("revoked_at"),
  revokedByUserId: integer("revoked_by_user_id").references(() => appUsers.id),
}, (table) => [
  uniqueIndex("idx_dataset_grants_pk").on(table.datasetVersionId, table.studentId),
]);

export const runSpecs = sqliteTable("run_specs", {
  sha256: text("sha256").primaryKey(),
  canonicalJson: text("canonical_json").notNull(),
  taskId: text("task_id").notNull().references(() => researchTasks.id),
  taskVersion: integer("task_version").notNull(),
  studentId: text("student_id").notNull().references(() => students.id),
  githubRepositoryId: integer("github_repository_id").notNull(),
  executedCommitSha: text("executed_commit_sha").notNull(),
  entrypointId: text("entrypoint_id").notNull().references(() => registeredEntrypoints.id),
  datasetVersionId: text("dataset_version_id").notNull().references(() => datasetVersions.id),
  changeRequestId: text("change_request_id").references(() => changeRequests.id),
  createdByUserId: integer("created_by_user_id").notNull().references(() => appUsers.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("run_spec_sha", sql`length(${table.executedCommitSha}) = 40`),
  index("idx_run_specs_task").on(table.taskId, table.createdAt),
]);

export const runApprovals = sqliteTable("run_approvals", {
  id: text("id").primaryKey(),
  runSpecSha256: text("run_spec_sha256").notNull().references(() => runSpecs.sha256),
  approvedByUserId: integer("approved_by_user_id").notNull().references(() => appUsers.id),
  note: text("note").notNull().default(""),
  approvedAt: text("approved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedAt: text("revoked_at"),
  revokedByUserId: integer("revoked_by_user_id").references(() => appUsers.id),
}, (table) => [
  index("idx_run_approvals_spec").on(table.runSpecSha256, table.approvedAt),
]);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  runSpecSha256: text("run_spec_sha256").notNull().references(() => runSpecs.sha256),
  attempt: integer("attempt").notNull().default(1),
  approvalId: text("approval_id").references(() => runApprovals.id),
  taskId: text("task_id").notNull().references(() => researchTasks.id),
  studentId: text("student_id").notNull().references(() => students.id),
  status: text("status").notNull().default("awaiting_approval"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  submitTag: text("submit_tag").notNull().unique(),
  runnerId: text("runner_id").references(() => labRunners.id),
  leaseEpoch: integer("lease_epoch").notNull().default(0),
  leaseExpiresAt: text("lease_expires_at"),
  heartbeatAt: text("heartbeat_at"),
  schedulerJobId: text("scheduler_job_id"),
  exitCode: integer("exit_code"),
  failureReason: text("failure_reason").notNull().default(""),
  cancelRequestedAt: text("cancel_requested_at"),
  cancelRequestedByUserId: integer("cancel_requested_by_user_id").references(() => appUsers.id),
  createdByUserId: integer("created_by_user_id").notNull().references(() => appUsers.id),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  queuedAt: text("queued_at"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("run_status", sql`${table.status} IN ('awaiting_approval', 'queued', 'dispatching', 'running', 'collecting', 'completed', 'failed', 'cancel_requested', 'canceled', 'reconciling')`),
  check("run_attempt", sql`${table.attempt} >= 1`),
  uniqueIndex("idx_runs_spec_attempt").on(table.runSpecSha256, table.attempt),
  index("idx_runs_queue").on(table.status, table.queuedAt),
  index("idx_runs_task").on(table.taskId, table.createdAt),
]);

export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => runs.id),
  sequence: integer("sequence").notNull(),
  fromStatus: text("from_status").notNull().default(""),
  toStatus: text("to_status").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull().default(""),
  payloadJson: text("payload_json").notNull().default("{}"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("run_event_actor", sql`${table.actorType} IN ('user', 'runner', 'system')`),
  uniqueIndex("idx_run_events_seq").on(table.runId, table.sequence),
]);

export const runArtifacts = sqliteTable("run_artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id),
  relativePath: text("relative_path").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  kind: text("kind").notNull(),
  egressDecision: text("egress_decision").notNull(),
  egressReason: text("egress_reason").notNull().default(""),
  r2Key: text("r2_key"),
  labLocator: text("lab_locator").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("run_artifact_kind", sql`${table.kind} IN ('metrics', 'figure', 'table', 'log', 'model', 'other')`),
  check("run_artifact_egress", sql`${table.egressDecision} IN ('published', 'held', 'rejected')`),
  check("run_artifact_size", sql`${table.sizeBytes} >= 0`),
  uniqueIndex("idx_run_artifacts_path").on(table.runId, table.relativePath),
]);

export const runResults = sqliteTable("run_results", {
  runId: text("run_id").primaryKey().references(() => runs.id),
  manifestSha256: text("manifest_sha256").notNull(),
  manifestJson: text("manifest_json").notNull(),
  metricsJson: text("metrics_json"),
  metricsSourceArtifactId: text("metrics_source_artifact_id").references(() => runArtifacts.id),
  technicalValidity: text("technical_validity").notNull().default("unknown"),
  validityNotes: text("validity_notes").notNull().default(""),
  reportCommitSha: text("report_commit_sha"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("run_result_validity", sql`${table.technicalValidity} IN ('valid', 'invalid', 'unknown')`),
]);

export const resultReviews = sqliteTable("result_reviews", {
  runId: text("run_id").primaryKey().references(() => runs.id),
  state: text("state").notNull().default("pending"),
  hypothesisOutcome: text("hypothesis_outcome").notNull().default("not_assessed"),
  reviewerUserId: integer("reviewer_user_id").references(() => appUsers.id),
  note: text("note").notNull().default(""),
  followupTaskId: text("followup_task_id").references(() => researchTasks.id),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("result_review_state", sql`${table.state} IN ('pending', 'accepted', 'rejected', 'needs_followup')`),
  check("result_review_hypothesis", sql`${table.hypothesisOutcome} IN ('not_assessed', 'supported', 'not_supported', 'inconclusive', 'not_applicable')`),
]);

export const resultComments = sqliteTable("result_comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: text("run_id").notNull().references(() => runs.id),
  authorUserId: integer("author_user_id").notNull().references(() => appUsers.id),
  parentCommentId: integer("parent_comment_id"),
  body: text("body").notNull(),
  requestId: text("request_id").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: text("deleted_at"),
}, (table) => [
  index("idx_result_comments_run").on(table.runId, table.id),
]);

// ---------------------------------------------------------------------------
// Schema 27: research loop batches 4–5 (docs/科研闭环_前端优化方案 FA2–FA4,
// FB1–FB3). Migration-owned like schema 26.
// ---------------------------------------------------------------------------

// FA2: comparison baseline for a run. Not part of the run spec or its approval
// hash; changing the baseline never changes what was approved.
export const runBaselines = sqliteTable("run_baselines", {
  runId: text("run_id").primaryKey().references(() => runs.id),
  baselineRunId: text("baseline_run_id").notNull().references(() => runs.id),
  setByUserId: integer("set_by_user_id").notNull().references(() => appUsers.id),
  setAt: text("set_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  check("run_baseline_not_self", sql`${table.runId} <> ${table.baselineRunId}`),
]);

// FA3: the student's own reading of a result, versioned, written before review.
export const resultInterpretations = sqliteTable("result_interpretations", {
  runId: text("run_id").notNull().references(() => runs.id),
  version: integer("version").notNull(),
  authorUserId: integer("author_user_id").notNull().references(() => appUsers.id),
  whatItShows: text("what_it_shows").notNull(),
  alternativeExplanations: text("alternative_explanations").notNull().default(""),
  limitations: text("limitations").notNull().default(""),
  proposedNextStep: text("proposed_next_step").notNull().default(""),
  requestId: text("request_id").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("idx_result_interpretations_pk").on(table.runId, table.version),
  check("result_interpretation_version", sql`${table.version} >= 1`),
]);

// FB1: a mentor delegates routine code review (G2, non-protected changes) of a
// student's agent changes to another platform user (e.g. a senior student).
// Grants only that: viewing the student's research-loop tasks/changes and
// publishing or rejecting non-protected change requests. Never run approval,
// extra review of protected paths, or result review.
export const reviewDelegations = sqliteTable("review_delegations", {
  id: text("id").primaryKey(),
  studentId: text("student_id").notNull().references(() => students.id),
  reviewerUserId: integer("reviewer_user_id").notNull().references(() => appUsers.id),
  delegatedByUserId: integer("delegated_by_user_id").notNull().references(() => appUsers.id),
  active: integer("active").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  revokedAt: text("revoked_at"),
  revokedByUserId: integer("revoked_by_user_id").references(() => appUsers.id),
}, (table) => [
  check("review_delegation_active", sql`${table.active} IN (0, 1)`),
  index("idx_review_delegations_reviewer").on(table.reviewerUserId, table.active),
  index("idx_review_delegations_student").on(table.studentId, table.active),
]);

// FB2: plan-first attempts. A row exists only for plan-first attempts; the
// agent first returns a plan (no file changes), a human approves or rejects
// it, and only an approved plan lets the worker proceed to edit code.
export const agentAttemptPlans = sqliteTable("agent_attempt_plans", {
  attemptId: text("attempt_id").primaryKey().references(() => agentAttempts.id),
  planText: text("plan_text").notNull().default(""),
  planSha256: text("plan_sha256").notNull().default(""),
  decision: text("decision").notNull().default("awaiting_plan"),
  submittedAt: text("submitted_at"),
  decidedByUserId: integer("decided_by_user_id").references(() => appUsers.id),
  decidedAt: text("decided_at"),
  note: text("note").notNull().default(""),
  version: integer("version").notNull().default(1),
}, (table) => [
  check("agent_attempt_plan_decision", sql`${table.decision} IN ('awaiting_plan', 'pending', 'approved', 'rejected')`),
]);

// FB3: idempotent loop notifications (Feishu bot), one row per event and
// recipient. Content is a short summary and a link; never code, data or hashes.
export const loopNotifications = sqliteTable("loop_notifications", {
  eventKey: text("event_key").notNull(),
  recipientUserId: integer("recipient_user_id").notNull().references(() => appUsers.id),
  channel: text("channel").notNull().default("feishu"),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  sentAt: text("sent_at"),
}, (table) => [
  uniqueIndex("idx_loop_notifications_pk").on(table.eventKey, table.recipientUserId, table.channel),
  check("loop_notification_status", sql`${table.status} IN ('pending', 'sent', 'skipped', 'failed')`),
]);
