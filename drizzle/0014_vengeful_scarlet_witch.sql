CREATE TABLE `student_guidance_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`mentor_user_id` integer NOT NULL,
	`source_progress_entry_id` integer,
	`guidance_type` text DEFAULT 'general' NOT NULL,
	`content` text NOT NULL,
	`next_action` text DEFAULT '' NOT NULL,
	`due_date` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mentor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "student_guidance_notes_type_check" CHECK("student_guidance_notes"."guidance_type" IN ('meeting_followup', 'paper', 'milestone', 'blocker', 'general')),
	CONSTRAINT "student_guidance_notes_status_check" CHECK("student_guidance_notes"."status" IN ('open', 'completed'))
);
--> statement-breakpoint
CREATE INDEX `idx_student_guidance_student_created` ON `student_guidance_notes` (`student_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_student_guidance_mentor_created` ON `student_guidance_notes` (`mentor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_student_guidance_source` ON `student_guidance_notes` (`source_progress_entry_id`);