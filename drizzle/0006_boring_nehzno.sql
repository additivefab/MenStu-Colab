CREATE TABLE `mentor_student_assignments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mentor_user_id` integer NOT NULL,
	`student_id` text NOT NULL,
	`relationship` text DEFAULT 'primary' NOT NULL,
	`can_review` integer DEFAULT true NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`mentor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mentor_student_unique` ON `mentor_student_assignments` (`mentor_user_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `idx_mentor_active_students` ON `mentor_student_assignments` (`mentor_user_id`,`active`,`student_id`);--> statement-breakpoint
CREATE INDEX `idx_student_active_mentors` ON `mentor_student_assignments` (`student_id`,`active`,`mentor_user_id`);--> statement-breakpoint
CREATE TABLE `progress_audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`progress_entry_id` integer NOT NULL,
	`actor_user_id` integer,
	`actor_type` text DEFAULT 'user' NOT NULL,
	`action` text NOT NULL,
	`from_status` text DEFAULT '' NOT NULL,
	`to_status` text DEFAULT '' NOT NULL,
	`assessment` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_progress_audit_entry_created` ON `progress_audit_events` (`progress_entry_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `progress_evidence_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`progress_entry_id` integer NOT NULL,
	`source_type` text NOT NULL,
	`label` text NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`source_import_id` integer,
	`content_sha256` text DEFAULT '' NOT NULL,
	`occurred_at` text,
	`created_by_user_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_import_id`) REFERENCES `feishu_meeting_summary_imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_progress_evidence_entry` ON `progress_evidence_sources` (`progress_entry_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_progress_evidence_import` ON `progress_evidence_sources` (`source_import_id`);--> statement-breakpoint
CREATE TABLE `research_output_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`output_id` integer NOT NULL,
	`actor_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`snapshot_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`output_id`) REFERENCES `research_outputs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_research_output_events_output` ON `research_output_events` (`output_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `research_outputs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`output_type` text NOT NULL,
	`title` text NOT NULL,
	`lifecycle_status` text DEFAULT 'planned' NOT NULL,
	`venue` text DEFAULT '' NOT NULL,
	`identifier` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`linked_milestone_id` integer,
	`created_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_milestone_id`) REFERENCES `research_milestones`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_research_outputs_student_updated` ON `research_outputs` (`student_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_research_outputs_status` ON `research_outputs` (`lifecycle_status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `review_status` text DEFAULT 'submitted' NOT NULL;--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `assessment` text;--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `submitted_by_user_id` integer;--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `reviewed_by_user_id` integer;--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `updated_at` text;--> statement-breakpoint
UPDATE `progress_entries` SET
	`review_status` = CASE `status`
		WHEN 'pending' THEN 'submitted'
		WHEN 'supplement' THEN 'changes_requested'
		WHEN 'rejected' THEN 'rejected'
		ELSE 'accepted'
	END,
	`assessment` = CASE `status`
		WHEN 'substantive' THEN 'substantive'
		WHEN 'supporting' THEN 'supporting'
		ELSE NULL
	END,
	`updated_at` = COALESCE(`reviewed_at`, `submitted_at`, CURRENT_TIMESTAMP);--> statement-breakpoint
INSERT INTO `progress_audit_events`
	(`progress_entry_id`, `actor_type`, `action`, `from_status`, `to_status`, `assessment`, `note`, `created_at`)
SELECT `id`, 'system', 'migration_backfill', '', `review_status`, COALESCE(`assessment`, ''),
	'历史进展迁移为分离的审核流程与导师判断', COALESCE(`reviewed_at`, `submitted_at`, CURRENT_TIMESTAMP)
FROM `progress_entries`;--> statement-breakpoint
INSERT INTO `progress_evidence_sources`
	(`progress_entry_id`, `source_type`, `label`, `source_ref`, `source_import_id`, `content_sha256`, `occurred_at`, `created_by_user_id`, `created_at`)
SELECT p.`id`,
	CASE
		WHEN i.`raw_content` LIKE '%/minutes/%' OR i.`extracted_text` LIKE '%飞书妙记 AI 会议纪要%' THEN 'feishu_minutes'
		WHEN i.`raw_content` LIKE '%/docx/%' OR i.`extracted_text` LIKE '%飞书智能纪要 AI 文档%' THEN 'feishu_docx'
		WHEN i.`id` IS NOT NULL THEN 'feishu_message'
		WHEN p.`git_url` != '' THEN 'git'
		WHEN p.`literature_ref` != '' THEN 'doi'
		ELSE 'manual'
	END,
	CASE
		WHEN i.`raw_content` LIKE '%/minutes/%' OR i.`extracted_text` LIKE '%飞书妙记 AI 会议纪要%' THEN '飞书妙记导入'
		WHEN i.`raw_content` LIKE '%/docx/%' OR i.`extracted_text` LIKE '%飞书智能纪要 AI 文档%' THEN '飞书智能纪要文档导入'
		WHEN i.`id` IS NOT NULL THEN '飞书智能纪要导入'
		WHEN p.`git_url` != '' THEN '历史 Git 证据'
		WHEN p.`literature_ref` != '' THEN '历史论文或 DOI'
		ELSE '历史文本证据'
	END,
	CASE WHEN i.`id` IS NULL AND p.`git_url` != '' THEN p.`git_url`
		WHEN i.`id` IS NULL AND p.`literature_ref` != '' THEN p.`literature_ref` ELSE '' END,
	i.`id`, '', COALESCE(i.`message_created_at`, p.`submitted_at`), p.`submitted_by_user_id`, p.`submitted_at`
FROM `progress_entries` p
LEFT JOIN `feishu_meeting_summary_links` l ON l.`progress_entry_id` = p.`id`
LEFT JOIN `feishu_meeting_summary_imports` i ON i.`id` = l.`import_id`;--> statement-breakpoint
CREATE INDEX `idx_progress_review_status` ON `progress_entries` (`review_status`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `idx_progress_reviewer` ON `progress_entries` (`reviewed_by_user_id`,`review_status`);--> statement-breakpoint
PRAGMA optimize;
