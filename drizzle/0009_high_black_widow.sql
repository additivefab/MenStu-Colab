CREATE TABLE IF NOT EXISTS `meeting_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`requested_by_user_id` integer NOT NULL,
	`preferred_date` text NOT NULL,
	`preferred_time` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`topic` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`handled_by_user_id` integer,
	`response_note` text DEFAULT '' NOT NULL,
	`handled_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handled_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "meeting_requests_duration_check" CHECK("meeting_requests"."duration_minutes" IN (15, 30, 45, 60)),
	CONSTRAINT "meeting_requests_status_check" CHECK("meeting_requests"."status" IN ('requested', 'confirmed', 'declined', 'cancelled')),
	CONSTRAINT "meeting_requests_version_check" CHECK("meeting_requests"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_meeting_requests_student_created` ON `meeting_requests` (`student_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_meeting_requests_requester_created` ON `meeting_requests` (`requested_by_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_meeting_requests_status_schedule` ON `meeting_requests` (`status`,`preferred_date`,`preferred_time`);
