CREATE TABLE `meeting_agenda_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agenda_id` integer NOT NULL,
	`student_id` text NOT NULL,
	`topic` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`duration_minutes` integer DEFAULT 10 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`agenda_id`) REFERENCES `meeting_agendas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "meeting_agenda_items_status_check" CHECK("meeting_agenda_items"."status" IN ('open', 'resolved')),
	CONSTRAINT "meeting_agenda_items_duration_check" CHECK("meeting_agenda_items"."duration_minutes" IN (5, 10, 15, 20, 30))
);
--> statement-breakpoint
CREATE INDEX `idx_meeting_agenda_items_agenda_order` ON `meeting_agenda_items` (`agenda_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_meeting_agenda_items_student_status` ON `meeting_agenda_items` (`student_id`,`status`);--> statement-breakpoint
CREATE TABLE `meeting_agendas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mentor_user_id` integer NOT NULL,
	`title` text NOT NULL,
	`meeting_date` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`mentor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "meeting_agendas_status_check" CHECK("meeting_agendas"."status" IN ('draft', 'scheduled', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_meeting_agendas_mentor_updated` ON `meeting_agendas` (`mentor_user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_meeting_agendas_status_date` ON `meeting_agendas` (`status`,`meeting_date`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`triggered_by_user_id` integer NOT NULL,
	`notification_type` text DEFAULT 'progress_reminder' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`idempotency_key` text NOT NULL,
	`attempt_token` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'sending' NOT NULL,
	`error_message` text DEFAULT '' NOT NULL,
	`provider_message_id` text DEFAULT '' NOT NULL,
	`sent_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`triggered_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_deliveries_type_check" CHECK("notification_deliveries"."notification_type" IN ('progress_reminder')),
	CONSTRAINT "notification_deliveries_status_check" CHECK("notification_deliveries"."status" IN ('sending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_deliveries_idempotency` ON `notification_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_student_created` ON `notification_deliveries` (`student_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_status_created` ON `notification_deliveries` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `review_claimed_at` text;--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `acceptance_criteria` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `verification_mode` text DEFAULT 'mentor_verify' NOT NULL CHECK (`verification_mode` IN ('self_report', 'mentor_verify'));--> statement-breakpoint
UPDATE `student_guidance_notes` SET `verification_mode` = 'self_report';--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `student_reported_at` text;--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `mentor_verified_at` text;--> statement-breakpoint
INSERT INTO `app_schema_meta` (`id`, `version`, `updated_at`)
VALUES (1, 18, CURRENT_TIMESTAMP)
ON CONFLICT(`id`) DO UPDATE SET
  `version` = MAX(`app_schema_meta`.`version`, excluded.`version`),
  `updated_at` = CURRENT_TIMESTAMP;
