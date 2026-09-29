import { env } from "cloudflare:workers";
import { provisionInitialStudentLogins } from "./initial-student-logins";
import { provisionLocalOnlyStudentLogins } from "./local-only-student-logins";
import { localAuthSchemaStatements, upgradeLocalCredentialsSchema } from "./local-auth-schema";
import { provisionAdministratorLogins } from "./administrator-logins";
import { progressResolutionSchemaStatements } from "./progress-resolution-schema";
import { createProgressDeletionsSql, protectDeletedProgressSql } from "./ai-record-deletion";

const DAY = 24 * 60 * 60 * 1000;

export const CURRENT_SCHEMA_VERSION = 24;

const REQUIRED_TABLES = [
  "students",
  "progress_entries",
  "progress_deletions",
  "app_users",
  "app_sessions",
  "local_credentials",
  "local_login_rollouts",
  "local_auth_events",
  "local_auth_attempts",
  "mentor_student_assignments",
  "student_guidance_notes",
  "student_guidance_events",
  "student_identity_binding_batches",
  "student_feishu_identity_bindings",
  "meeting_requests",
  "meeting_agendas",
  "meeting_agenda_items",
  "notification_deliveries",
  "progress_audit_events",
  "progress_attachments",
  "progress_file_cleanup_queue",
  "progress_revisions",
  "progress_resolutions",
  "progress_resolution_events",
  "progress_resolution_attachments",
  "student_papers",
  "paper_submission_candidates",
  "paper_progress_details",
  "research_proposals",
  "research_milestones",
  "project_progress_details",
  "research_outputs",
  "feishu_meeting_summary_imports",
  "feishu_meeting_summary_links",
  "progress_evidence_sources",
] as const;

export type DatabaseSchemaStatus = {
  version: number | null;
  expectedVersion: number;
  missingTables: string[];
};

let databaseReadyPromise: Promise<void> | null = null;

export function getD1() {
  if (!env.DB) {
    throw new Error("D1 binding DB is unavailable");
  }
  return env.DB;
}

async function ensureColumn(
  table: "local_credentials" | "app_sessions" | "app_user_role_events" | "progress_entries" | "progress_attachments" | "progress_evidence_sources" | "research_milestones" | "student_guidance_notes" | "notification_deliveries" | "meeting_requests",
  column: string,
  definition: string,
) {
  const d1 = getD1();
  const { results } = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (results.some((item) => item.name === column)) return;
  try {
    await d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (error) {
    const current = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!current.results.some((item) => item.name === column)) throw error;
  }
}

export async function getDatabaseSchemaStatus(): Promise<DatabaseSchemaStatus> {
  const d1 = getD1();
  const placeholders = REQUIRED_TABLES.map(() => "?").join(",");
  const tables = await d1.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${placeholders})`)
    .bind(...REQUIRED_TABLES)
    .all<{ name: string }>();
  const present = new Set(tables.results.map((item) => item.name));
  const metaTable = await d1.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'app_schema_meta'`).first<{ name: string }>();
  const meta = metaTable
    ? await d1.prepare("SELECT version FROM app_schema_meta WHERE id = 1").first<{ version: number }>()
    : null;
  return {
    version: meta ? Number(meta.version) : null,
    expectedVersion: CURRENT_SCHEMA_VERSION,
    missingTables: REQUIRED_TABLES.filter((name) => !present.has(name)),
  };
}

async function prepareDatabase() {
  const before = await getDatabaseSchemaStatus();
  if (before.version === CURRENT_SCHEMA_VERSION) {
    if (before.missingTables.length) {
      throw new Error(`数据库结构不完整：缺少 ${before.missingTables.join("、")}`);
    }
    return;
  }
  if (before.version !== null && before.version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${before.version} 高于应用支持版本 ${CURRENT_SCHEMA_VERSION}`);
  }
  await migrateDatabase(before.version);
  const after = await getDatabaseSchemaStatus();
  if (after.version !== CURRENT_SCHEMA_VERSION || after.missingTables.length) {
    throw new Error("数据库升级未完成，系统已停止继续读写");
  }
}

export async function ensureDatabase() {
  databaseReadyPromise ??= prepareDatabase().then(async () => {
    await provisionInitialStudentLogins(getD1());
    await provisionLocalOnlyStudentLogins(getD1());
    await provisionAdministratorLogins(getD1());
  }).catch((error) => {
    databaseReadyPromise = null;
    throw error;
  });
  return databaseReadyPromise;
}

async function migrateDatabase(previousVersion: number | null) {
  const d1 = getD1();
  if (previousVersion === 23) {
    await upgradeLocalCredentialsSchema(d1);
    await d1.prepare("UPDATE app_schema_meta SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1 AND version = 23")
      .bind(CURRENT_SCHEMA_VERSION).run();
    return;
  }
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      degree TEXT NOT NULL,
      grade_year INTEGER NOT NULL,
      stage TEXT NOT NULL,
      cadence_days INTEGER NOT NULL DEFAULT 30,
      current_focus TEXT NOT NULL DEFAULT '',
      last_substantive_at TEXT,
      tracking_started_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      literature_ref TEXT NOT NULL DEFAULT '',
      git_url TEXT NOT NULL DEFAULT '',
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'pending',
      review_status TEXT NOT NULL DEFAULT 'submitted',
      assessment TEXT,
      submitted_by_user_id INTEGER,
      reviewed_by_user_id INTEGER,
      review_claimed_at TEXT,
      reviewer_note TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT,
      current_revision INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT NOT NULL DEFAULT '',
      request_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feishu_open_id TEXT NOT NULL UNIQUE,
      feishu_union_id TEXT NOT NULL DEFAULT '',
      feishu_user_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'pending',
      student_id TEXT REFERENCES students(id),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY,
      app_user_id INTEGER NOT NULL REFERENCES app_users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS mentor_student_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      student_id TEXT NOT NULL REFERENCES students(id),
      relationship TEXT NOT NULL DEFAULT 'primary',
      can_review INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS student_guidance_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      mentor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      source_progress_entry_id INTEGER REFERENCES progress_entries(id),
      guidance_type TEXT NOT NULL DEFAULT 'general'
        CHECK (guidance_type IN ('meeting_followup', 'paper', 'milestone', 'blocker', 'general')),
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      next_action TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      verification_mode TEXT NOT NULL DEFAULT 'mentor_verify'
        CHECK (verification_mode IN ('self_report', 'mentor_verify')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
      acknowledged_at TEXT,
      student_reported_at TEXT,
      mentor_verified_at TEXT,
      completed_at TEXT,
      completed_by_user_id INTEGER REFERENCES app_users(id),
      completion_note TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS student_guidance_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guidance_note_id INTEGER NOT NULL REFERENCES student_guidance_notes(id),
      actor_user_id INTEGER REFERENCES app_users(id),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('staff', 'student', 'system')),
      action TEXT NOT NULL CHECK (action IN ('created', 'acknowledged', 'completed', 'reopened')),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_user_role_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_user_id INTEGER NOT NULL REFERENCES app_users(id),
      actor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      request_id TEXT NOT NULL UNIQUE,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS student_identity_binding_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      request_id TEXT NOT NULL UNIQUE,
      record_count INTEGER NOT NULL CHECK (record_count = 26),
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS student_feishu_identity_bindings (
      student_id TEXT PRIMARY KEY REFERENCES students(id),
      feishu_open_id TEXT NOT NULL UNIQUE,
      batch_id INTEGER NOT NULL REFERENCES student_identity_binding_batches(id),
      verified_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      verification_method TEXT NOT NULL DEFAULT 'feishu_contact_batch_get_id',
      contact_kind TEXT NOT NULL CHECK (contact_kind IN ('email', 'mobile', 'existing_login')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS meeting_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      requested_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      preferred_date TEXT NOT NULL,
      preferred_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes IN (15, 30, 45, 60)),
      topic TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'confirmed', 'declined', 'cancelled')),
      handled_by_user_id INTEGER REFERENCES app_users(id),
      response_note TEXT NOT NULL DEFAULT '',
      handled_at TEXT,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      idempotency_key TEXT NOT NULL DEFAULT '',
      request_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS meeting_agendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mentor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      title TEXT NOT NULL,
      meeting_date TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'scheduled', 'completed', 'cancelled')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS meeting_agenda_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agenda_id INTEGER NOT NULL REFERENCES meeting_agendas(id),
      student_id TEXT NOT NULL REFERENCES students(id),
      topic TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      duration_minutes INTEGER NOT NULL DEFAULT 10
        CHECK (duration_minutes IN (5, 10, 15, 20, 30)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS notification_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      triggered_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      notification_type TEXT NOT NULL DEFAULT 'progress_reminder'
        CHECK (notification_type IN ('progress_reminder')),
      reason TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL UNIQUE,
      attempt_token TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
      error_message TEXT NOT NULL DEFAULT '',
      provider_message_id TEXT NOT NULL DEFAULT '',
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id),
      actor_user_id INTEGER REFERENCES app_users(id),
      actor_type TEXT NOT NULL DEFAULT 'user',
      action TEXT NOT NULL,
      from_status TEXT NOT NULL DEFAULT '',
      to_status TEXT NOT NULL DEFAULT '',
      assessment TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id),
      storage_key TEXT NOT NULL,
      file_name TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      revision_number INTEGER NOT NULL DEFAULT 1,
      uploaded_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_file_cleanup_queue (
      storage_key TEXT PRIMARY KEY,
      progress_entry_id INTEGER REFERENCES progress_entries(id) ON DELETE SET NULL,
      student_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL DEFAULT 'compensation_failed',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id),
      revision_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      submitted_by_user_id INTEGER REFERENCES app_users(id),
      review_status TEXT NOT NULL DEFAULT 'submitted',
      assessment TEXT,
      reviewer_note TEXT NOT NULL DEFAULT '',
      reviewed_by_user_id INTEGER REFERENCES app_users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS student_papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      title TEXT NOT NULL,
      paper_type TEXT NOT NULL DEFAULT '期刊论文',
      target_venue TEXT NOT NULL DEFAULT '',
      planned_submission_date TEXT,
      current_stage TEXT NOT NULL DEFAULT 'planning',
      submission_identifier TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      latest_progress_at TEXT,
      created_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS paper_submission_candidates (
      progress_entry_id INTEGER PRIMARY KEY REFERENCES progress_entries(id),
      title TEXT NOT NULL,
      paper_type TEXT NOT NULL,
      target_venue TEXT NOT NULL DEFAULT '',
      planned_submission_date TEXT NOT NULL,
      stage TEXT NOT NULL,
      manuscript_version TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL,
      next_action_due_date TEXT NOT NULL,
      blocker TEXT NOT NULL DEFAULT '',
      submission_identifier TEXT NOT NULL DEFAULT '',
      promoted_paper_id INTEGER REFERENCES student_papers(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS paper_progress_details (
      progress_entry_id INTEGER PRIMARY KEY REFERENCES progress_entries(id),
      paper_id INTEGER NOT NULL REFERENCES student_papers(id),
      stage TEXT NOT NULL,
      manuscript_version TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL,
      next_action_due_date TEXT NOT NULL,
      blocker TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      title TEXT NOT NULL DEFAULT '未命名方案',
      scientific_question TEXT NOT NULL DEFAULT '',
      hypothesis TEXT NOT NULL DEFAULT '',
      objectives TEXT NOT NULL DEFAULT '',
      innovation TEXT NOT NULL DEFAULT '',
      literature_basis TEXT NOT NULL DEFAULT '',
      methodology TEXT NOT NULL DEFAULT '',
      data_ethics TEXT NOT NULL DEFAULT '',
      risks TEXT NOT NULL DEFAULT '',
      resources TEXT NOT NULL DEFAULT '',
      references_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      current_version INTEGER NOT NULL DEFAULT 0,
      reviewer_note TEXT NOT NULL DEFAULT '',
      created_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      submitted_at TEXT,
      approved_at TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_proposal_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES research_proposals(id),
      version_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      submitted_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES research_proposals(id),
      title TEXT NOT NULL,
      target_date TEXT NOT NULL,
      evidence_target TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      sort_order INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS project_progress_details (
      progress_entry_id INTEGER PRIMARY KEY REFERENCES progress_entries(id),
      milestone_id INTEGER REFERENCES research_milestones(id),
      milestone_title TEXT NOT NULL DEFAULT '',
      milestone_target_date TEXT,
      evidence_target TEXT NOT NULL DEFAULT '',
      proposal_version INTEGER,
      next_action TEXT NOT NULL,
      next_action_due_date TEXT NOT NULL,
      blocker TEXT NOT NULL DEFAULT '',
      completion_requested INTEGER NOT NULL DEFAULT 0 CHECK (completion_requested IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL REFERENCES students(id),
      output_type TEXT NOT NULL,
      title TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL DEFAULT 'planned',
      venue TEXT NOT NULL DEFAULT '',
      identifier TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      linked_milestone_id INTEGER REFERENCES research_milestones(id),
      created_by_user_id INTEGER NOT NULL REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS research_output_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      output_id INTEGER NOT NULL REFERENCES research_outputs(id),
      actor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS proposal_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES research_proposals(id),
      actor_user_id INTEGER NOT NULL REFERENCES app_users(id),
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS feishu_meeting_summary_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL DEFAULT '',
      sender_type TEXT NOT NULL DEFAULT '',
      message_type TEXT NOT NULL DEFAULT '',
      raw_content TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      detected_reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      message_created_at TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewed_by_user_id INTEGER REFERENCES app_users(id),
      reviewed_at TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS feishu_meeting_summary_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER NOT NULL REFERENCES feishu_meeting_summary_imports(id),
      student_id TEXT NOT NULL REFERENCES students(id),
      progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS progress_evidence_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      progress_entry_id INTEGER NOT NULL REFERENCES progress_entries(id),
      source_type TEXT NOT NULL,
      label TEXT NOT NULL,
      source_ref TEXT NOT NULL DEFAULT '',
      source_import_id INTEGER REFERENCES feishu_meeting_summary_imports(id),
      content_sha256 TEXT NOT NULL DEFAULT '',
      revision_number INTEGER NOT NULL DEFAULT 1,
      occurred_at TEXT,
      created_by_user_id INTEGER REFERENCES app_users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(createProgressDeletionsSql),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_student_submitted ON progress_entries(student_id, submitted_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_status ON progress_entries(status, submitted_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_feishu_open_id ON app_users(feishu_open_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_users_role ON app_users(role)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_student_id_unique ON app_users(student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(app_user_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_mentor_student_unique ON mentor_student_assignments(mentor_user_id, student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_mentor_active_students ON mentor_student_assignments(mentor_user_id, active, student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_active_mentors ON mentor_student_assignments(student_id, active, mentor_user_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_guidance_student_created ON student_guidance_notes(student_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_guidance_mentor_created ON student_guidance_notes(mentor_user_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_guidance_source ON student_guidance_notes(source_progress_entry_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_guidance_events_note_created ON student_guidance_events(guidance_note_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_user_role_events_target ON app_user_role_events(target_user_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_app_user_role_events_actor ON app_user_role_events(actor_user_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_identity_bindings_open_id ON student_feishu_identity_bindings(feishu_open_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_identity_bindings_batch ON student_feishu_identity_bindings(batch_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_requests_student_created ON meeting_requests(student_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_requests_requester_created ON meeting_requests(requested_by_user_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_requests_status_schedule ON meeting_requests(status, preferred_date, preferred_time)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_agendas_mentor_updated ON meeting_agendas(mentor_user_id, updated_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_agendas_status_date ON meeting_agendas(status, meeting_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_agenda_items_agenda_order ON meeting_agenda_items(agenda_id, sort_order)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_meeting_agenda_items_student_status ON meeting_agenda_items(student_id, status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_idempotency ON notification_deliveries(idempotency_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_notification_deliveries_student_created ON notification_deliveries(student_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status_created ON notification_deliveries(status, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_audit_entry_created ON progress_audit_events(progress_entry_id, created_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_attachments_storage_key ON progress_attachments(storage_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_attachments_entry_created ON progress_attachments(progress_entry_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_cleanup_updated ON progress_file_cleanup_queue(updated_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_cleanup_entry ON progress_file_cleanup_queue(progress_entry_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_revisions_entry_number ON progress_revisions(progress_entry_id, revision_number)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_revisions_entry_created ON progress_revisions(progress_entry_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_papers_student_status ON student_papers(student_id, status, updated_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_student_papers_stage_due ON student_papers(current_stage, planned_submission_date)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_candidates_promoted ON paper_submission_candidates(promoted_paper_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_paper_progress_paper_created ON paper_progress_details(paper_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_paper_progress_due ON paper_progress_details(next_action_due_date, stage)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_research_proposals_student_unique ON research_proposals(student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_proposals_status_updated ON research_proposals(status, updated_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_versions_proposal_number ON research_proposal_versions(proposal_id, version_number)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_proposal_versions_created ON research_proposal_versions(proposal_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_milestones_proposal_order ON research_milestones(proposal_id, sort_order)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_project_progress_milestone_created ON project_progress_details(milestone_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_project_progress_due ON project_progress_details(next_action_due_date)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_outputs_student_updated ON research_outputs(student_id, updated_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_outputs_status ON research_outputs(lifecycle_status, updated_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_research_output_events_output ON research_output_events(output_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_proposal_audit_proposal_created ON proposal_audit_events(proposal_id, created_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_summary_event_unique ON feishu_meeting_summary_imports(event_id)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_summary_message_unique ON feishu_meeting_summary_imports(message_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_feishu_summary_status_received ON feishu_meeting_summary_imports(status, received_at DESC)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_summary_link_import_student ON feishu_meeting_summary_links(import_id, student_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_feishu_summary_link_student ON feishu_meeting_summary_links(student_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_evidence_entry ON progress_evidence_sources(progress_entry_id, created_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_evidence_import ON progress_evidence_sources(source_import_id)"),
  ]);

  // 业务层将 mentor 映射为管理员（导师）；保留旧存储值可避免回滚时权限被放大。
  await d1.prepare("UPDATE app_users SET role = 'mentor' WHERE role = 'admin'").run();

  await ensureColumn("app_user_role_events", "request_id", "TEXT");
  await d1.batch([
    d1.prepare("UPDATE app_user_role_events SET request_id = 'legacy-' || id WHERE request_id IS NULL OR request_id = ''"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_app_user_role_events_request ON app_user_role_events(request_id)"),
  ]);

  await ensureColumn("progress_entries", "review_status", "TEXT NOT NULL DEFAULT 'submitted'");
  await ensureColumn("progress_entries", "assessment", "TEXT");
  await ensureColumn("progress_entries", "submitted_by_user_id", "INTEGER REFERENCES app_users(id)");
  await ensureColumn("progress_entries", "reviewed_by_user_id", "INTEGER REFERENCES app_users(id)");
  await ensureColumn("progress_entries", "review_claimed_at", "TEXT");
  await ensureColumn("progress_entries", "current_revision", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("progress_entries", "idempotency_key", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("progress_entries", "request_hash", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("progress_entries", "updated_at", "TEXT");
  await ensureColumn("progress_attachments", "revision_number", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("progress_evidence_sources", "revision_number", "INTEGER NOT NULL DEFAULT 1");
  await ensureColumn("research_milestones", "archived_at", "TEXT");
  await ensureColumn("student_guidance_notes", "title", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("student_guidance_notes", "acceptance_criteria", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("student_guidance_notes", "verification_mode", "TEXT NOT NULL DEFAULT 'mentor_verify' CHECK (verification_mode IN ('self_report', 'mentor_verify'))");
  if (previousVersion === null || previousVersion < 18) {
    // V17 及更早版本的指导由学生自行确认完成；升级时不能静默改成导师验收。
    await d1.prepare("UPDATE student_guidance_notes SET verification_mode = 'self_report'").run();
  }
  await ensureColumn("student_guidance_notes", "acknowledged_at", "TEXT");
  await ensureColumn("student_guidance_notes", "student_reported_at", "TEXT");
  await ensureColumn("student_guidance_notes", "mentor_verified_at", "TEXT");
  await ensureColumn("student_guidance_notes", "completed_at", "TEXT");
  await ensureColumn("student_guidance_notes", "completed_by_user_id", "INTEGER REFERENCES app_users(id)");
  await ensureColumn("student_guidance_notes", "completion_note", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("student_guidance_notes", "version", "INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)");
  await ensureColumn("notification_deliveries", "attempt_token", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("notification_deliveries", "provider_message_id", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("meeting_requests", "idempotency_key", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("meeting_requests", "request_hash", "TEXT NOT NULL DEFAULT ''");
  await d1.batch(localAuthSchemaStatements.map((statement) => d1.prepare(statement)));
  await ensureColumn("local_credentials", "must_change_password", "INTEGER NOT NULL DEFAULT 0");
  await upgradeLocalCredentialsSchema(d1);
  await ensureColumn("app_sessions", "auth_method", "TEXT NOT NULL DEFAULT 'feishu'");
  await ensureColumn("app_sessions", "local_credential_version", "INTEGER");
  await ensureColumn("app_sessions", "local_student_id", "TEXT");

  await d1.batch([
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_attachments_entry_revision ON progress_attachments(progress_entry_id, revision_number)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_evidence_entry_revision ON progress_evidence_sources(progress_entry_id, revision_number)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_submitter_idempotency ON progress_entries(submitted_by_user_id, idempotency_key) WHERE idempotency_key <> ''"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_requester_idempotency ON meeting_requests(requested_by_user_id, idempotency_key) WHERE idempotency_key <> ''"),
    d1.prepare(`UPDATE progress_entries SET
      review_status = CASE status
        WHEN 'substantive' THEN 'accepted'
        WHEN 'supporting' THEN 'accepted'
        WHEN 'supplement' THEN 'changes_requested'
        WHEN 'rejected' THEN 'rejected'
        ELSE 'submitted'
      END,
      assessment = CASE status
        WHEN 'substantive' THEN 'substantive'
        WHEN 'supporting' THEN 'supporting'
        ELSE NULL
      END,
      updated_at = COALESCE(reviewed_at, submitted_at, CURRENT_TIMESTAMP)
      WHERE updated_at IS NULL`),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_review_status ON progress_entries(review_status, submitted_at DESC)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_progress_reviewer ON progress_entries(reviewed_by_user_id, review_status)"),
    d1.prepare(`INSERT INTO progress_audit_events
      (progress_entry_id, actor_type, action, from_status, to_status, assessment, note, created_at)
      SELECT p.id, 'legacy', 'legacy_review', 'submitted', p.review_status,
        COALESCE(p.assessment, ''), p.reviewer_note, COALESCE(p.reviewed_at, p.submitted_at)
      FROM progress_entries p
      WHERE p.review_status != 'submitted'
        AND NOT EXISTS (SELECT 1 FROM progress_audit_events a WHERE a.progress_entry_id = p.id)`),
    d1.prepare(`INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, source_import_id, occurred_at)
      SELECT l.progress_entry_id,
        CASE WHEN i.raw_content LIKE '%/minutes/%' OR i.extracted_text LIKE '%飞书妙记 AI 会议纪要%' THEN 'feishu_minutes'
          WHEN i.raw_content LIKE '%/docx/%' OR i.extracted_text LIKE '%飞书智能纪要 AI 文档%' THEN 'feishu_docx'
          ELSE 'feishu_message' END,
        CASE WHEN i.raw_content LIKE '%/minutes/%' OR i.extracted_text LIKE '%飞书妙记 AI 会议纪要%' THEN '飞书妙记导入'
          WHEN i.raw_content LIKE '%/docx/%' OR i.extracted_text LIKE '%飞书智能纪要 AI 文档%' THEN '飞书智能纪要文档导入'
          ELSE '飞书智能纪要导入' END,
        '', l.import_id, i.message_created_at
      FROM feishu_meeting_summary_links l
      JOIN feishu_meeting_summary_imports i ON i.id = l.import_id
      WHERE NOT EXISTS (
        SELECT 1 FROM progress_evidence_sources e
        WHERE e.progress_entry_id = l.progress_entry_id AND e.source_import_id = l.import_id
      )`),
    d1.prepare(`INSERT INTO progress_evidence_sources
      (progress_entry_id, source_type, label, source_ref, occurred_at, created_by_user_id)
      SELECT p.id,
        CASE WHEN p.git_url != '' THEN 'git' WHEN p.literature_ref != '' THEN 'doi' ELSE 'manual' END,
        CASE WHEN p.git_url != '' THEN '历史 Git 证据'
          WHEN p.literature_ref != '' THEN '历史论文或 DOI' ELSE '历史文本证据' END,
        CASE WHEN p.git_url != '' THEN p.git_url WHEN p.literature_ref != '' THEN p.literature_ref ELSE '' END,
        p.submitted_at, p.submitted_by_user_id
      FROM progress_entries p
      WHERE NOT EXISTS (SELECT 1 FROM progress_evidence_sources e WHERE e.progress_entry_id = p.id)`),
    d1.prepare(`INSERT INTO progress_revisions
      (progress_entry_id, revision_number, snapshot_json, submitted_by_user_id,
       review_status, assessment, reviewer_note, reviewed_by_user_id, reviewed_at, created_at)
      SELECT p.id, 1,
        json_object(
          'kind', p.kind,
          'title', p.title,
          'summary', p.summary,
          'evidence', p.evidence,
          'literatureRef', p.literature_ref,
          'gitUrl', p.git_url,
          'attachments', json_array(),
          'paper', NULL,
          'project', NULL
        ),
        CASE WHEN EXISTS (
          SELECT 1 FROM app_users submitter WHERE submitter.id = p.submitted_by_user_id
        ) THEN p.submitted_by_user_id ELSE NULL END,
        p.review_status, p.assessment, p.reviewer_note,
        CASE WHEN EXISTS (
          SELECT 1 FROM app_users reviewer WHERE reviewer.id = p.reviewed_by_user_id
        ) THEN p.reviewed_by_user_id ELSE NULL END,
        p.reviewed_at, p.submitted_at
      FROM progress_entries p
      WHERE NOT EXISTS (
        SELECT 1 FROM progress_revisions r WHERE r.progress_entry_id = p.id
      )`),
    ...progressResolutionSchemaStatements.map((statement) => d1.prepare(statement)),
    ...localAuthSchemaStatements.map((statement) => d1.prepare(statement)),
    d1.prepare(protectDeletedProgressSql),
    d1.prepare("UPDATE app_users SET email = '' WHERE email != ''"),
    d1.prepare(`INSERT INTO app_schema_meta (id, version, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = CURRENT_TIMESTAMP`)
      .bind(CURRENT_SCHEMA_VERSION),
    d1.prepare("PRAGMA optimize"),
  ]);
}

export function riskFromDate(value: string | null) {
  if (!value) return { level: "红色", days: 999 };
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / DAY));
  if (days >= 90) return { level: "红色", days };
  if (days >= 60) return { level: "橙色", days };
  if (days >= 30) return { level: "黄色", days };
  return { level: "正常", days };
}
