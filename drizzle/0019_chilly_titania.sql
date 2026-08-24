CREATE TABLE `paper_submission_candidates` (
	`progress_entry_id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`paper_type` text NOT NULL,
	`target_venue` text DEFAULT '' NOT NULL,
	`planned_submission_date` text NOT NULL,
	`stage` text NOT NULL,
	`manuscript_version` text DEFAULT '' NOT NULL,
	`next_action` text NOT NULL,
	`next_action_due_date` text NOT NULL,
	`blocker` text DEFAULT '' NOT NULL,
	`submission_identifier` text DEFAULT '' NOT NULL,
	`promoted_paper_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`promoted_paper_id`) REFERENCES `student_papers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_paper_candidates_promoted` ON `paper_submission_candidates` (`promoted_paper_id`);--> statement-breakpoint
CREATE TABLE `progress_file_cleanup_queue` (
	`storage_key` text PRIMARY KEY NOT NULL,
	`progress_entry_id` integer,
	`student_id` text NOT NULL,
	`revision_number` integer DEFAULT 1 NOT NULL,
	`reason` text DEFAULT 'compensation_failed' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_progress_cleanup_updated` ON `progress_file_cleanup_queue` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_progress_cleanup_entry` ON `progress_file_cleanup_queue` (`progress_entry_id`);--> statement-breakpoint
ALTER TABLE `meeting_requests` ADD `idempotency_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `meeting_requests` ADD `request_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_meeting_requester_idempotency` ON `meeting_requests` (`requested_by_user_id`,`idempotency_key`) WHERE "meeting_requests"."idempotency_key" <> '';--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `idempotency_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `request_hash` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_progress_submitter_idempotency` ON `progress_entries` (`submitted_by_user_id`,`idempotency_key`) WHERE "progress_entries"."idempotency_key" <> '';--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `version` integer DEFAULT 1 NOT NULL CHECK (`version` >= 1);--> statement-breakpoint
INSERT INTO `app_schema_meta` (`id`, `version`, `updated_at`)
VALUES (1, 19, CURRENT_TIMESTAMP)
ON CONFLICT(`id`) DO UPDATE SET
  `version` = MAX(`app_schema_meta`.`version`, excluded.`version`),
  `updated_at` = CURRENT_TIMESTAMP;
