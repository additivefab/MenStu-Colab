CREATE TABLE `app_schema_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "app_schema_meta_singleton" CHECK("app_schema_meta"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `student_guidance_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guidance_note_id` integer NOT NULL,
	`actor_user_id` integer,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`guidance_note_id`) REFERENCES `student_guidance_notes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "student_guidance_events_actor_type" CHECK("student_guidance_events"."actor_type" IN ('staff', 'student', 'system')),
	CONSTRAINT "student_guidance_events_action" CHECK("student_guidance_events"."action" IN ('created', 'acknowledged', 'completed', 'reopened'))
);
--> statement-breakpoint
CREATE INDEX `idx_student_guidance_events_note_created` ON `student_guidance_events` (`guidance_note_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `acknowledged_at` text;--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `completed_at` text;--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `completed_by_user_id` integer REFERENCES app_users(id);--> statement-breakpoint
ALTER TABLE `student_guidance_notes` ADD `completion_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `app_users` SET `email` = '' WHERE `email` != '';--> statement-breakpoint
INSERT INTO `app_schema_meta` (`id`, `version`, `updated_at`)
VALUES (1, 16, CURRENT_TIMESTAMP)
ON CONFLICT(`id`) DO UPDATE SET `version` = excluded.`version`, `updated_at` = CURRENT_TIMESTAMP;
