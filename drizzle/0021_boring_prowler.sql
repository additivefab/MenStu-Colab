CREATE TABLE `progress_resolution_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `progress_resolution_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_resolution_attachments_storage` ON `progress_resolution_attachments` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_resolution_attachments_event` ON `progress_resolution_attachments` (`event_id`);--> statement-breakpoint
CREATE TABLE `progress_resolution_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`resolution_id` integer NOT NULL,
	`actor_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`from_status` text NOT NULL,
	`to_status` text NOT NULL,
	`version` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`resolution_id`) REFERENCES `progress_resolutions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "progress_resolution_events_action" CHECK("progress_resolution_events"."action" IN ('submit', 'confirm', 'request_changes', 'reopen'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_resolution_events_request` ON `progress_resolution_events` (`actor_user_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_resolution_events_version` ON `progress_resolution_events` (`resolution_id`,`version`);--> statement-breakpoint
CREATE TABLE `progress_resolutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`progress_entry_id` integer NOT NULL,
	`revision_number` integer NOT NULL,
	`item_kind` text NOT NULL,
	`source_title` text NOT NULL,
	`source_text` text NOT NULL,
	`source_due_date` text,
	`track_type` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`submission_note` text DEFAULT '' NOT NULL,
	`reviewer_note` text DEFAULT '' NOT NULL,
	`submitted_by_user_id` integer,
	`submitted_at` text,
	`resolved_at` text,
	`last_request_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "progress_resolutions_kind" CHECK("progress_resolutions"."item_kind" IN ('blocker', 'next_action')),
	CONSTRAINT "progress_resolutions_status" CHECK("progress_resolutions"."status" IN ('open', 'pending', 'resolved', 'changes_requested')),
	CONSTRAINT "progress_resolutions_version" CHECK("progress_resolutions"."version" >= 1 AND "progress_resolutions"."revision_number" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_progress_resolutions_source` ON `progress_resolutions` (`progress_entry_id`,`revision_number`,`item_kind`);--> statement-breakpoint
CREATE INDEX `idx_progress_resolutions_student_status` ON `progress_resolutions` (`student_id`,`status`);
--> statement-breakpoint
INSERT INTO app_schema_meta (id, version, updated_at) VALUES (1, 21, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET version = MAX(app_schema_meta.version, excluded.version), updated_at = CURRENT_TIMESTAMP;
