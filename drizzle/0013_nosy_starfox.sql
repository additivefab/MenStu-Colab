CREATE TABLE `paper_progress_details` (
	`progress_entry_id` integer PRIMARY KEY NOT NULL,
	`paper_id` integer NOT NULL,
	`stage` text NOT NULL,
	`manuscript_version` text DEFAULT '' NOT NULL,
	`next_action` text NOT NULL,
	`next_action_due_date` text NOT NULL,
	`blocker` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paper_id`) REFERENCES `student_papers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_paper_progress_paper_created` ON `paper_progress_details` (`paper_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_paper_progress_due` ON `paper_progress_details` (`next_action_due_date`,`stage`);--> statement-breakpoint
CREATE TABLE `student_papers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`title` text NOT NULL,
	`paper_type` text DEFAULT '期刊论文' NOT NULL,
	`target_venue` text DEFAULT '' NOT NULL,
	`planned_submission_date` text,
	`current_stage` text DEFAULT 'planning' NOT NULL,
	`submission_identifier` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`latest_progress_at` text,
	`created_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_student_papers_student_status` ON `student_papers` (`student_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_student_papers_stage_due` ON `student_papers` (`current_stage`,`planned_submission_date`);