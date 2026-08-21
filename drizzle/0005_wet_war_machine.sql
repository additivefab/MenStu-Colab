CREATE TABLE `feishu_meeting_summary_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`message_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`sender_id` text DEFAULT '' NOT NULL,
	`sender_type` text DEFAULT '' NOT NULL,
	`message_type` text DEFAULT '' NOT NULL,
	`raw_content` text NOT NULL,
	`extracted_text` text NOT NULL,
	`detected_reason` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`message_created_at` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`reviewed_by_user_id` integer,
	`reviewed_at` text,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feishu_summary_event_unique` ON `feishu_meeting_summary_imports` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feishu_summary_message_unique` ON `feishu_meeting_summary_imports` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_feishu_summary_status_received` ON `feishu_meeting_summary_imports` (`status`,`received_at`);--> statement-breakpoint
CREATE TABLE `feishu_meeting_summary_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_id` integer NOT NULL,
	`student_id` text NOT NULL,
	`progress_entry_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `feishu_meeting_summary_imports`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feishu_summary_link_import_student` ON `feishu_meeting_summary_links` (`import_id`,`student_id`);--> statement-breakpoint
CREATE INDEX `idx_feishu_summary_link_student` ON `feishu_meeting_summary_links` (`student_id`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
