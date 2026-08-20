CREATE TABLE `progress_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	`literature_ref` text DEFAULT '' NOT NULL,
	`git_url` text DEFAULT '' NOT NULL,
	`submitted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_note` text DEFAULT '' NOT NULL,
	`reviewed_at` text,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`degree` text NOT NULL,
	`grade_year` integer NOT NULL,
	`stage` text NOT NULL,
	`cadence_days` integer DEFAULT 30 NOT NULL,
	`current_focus` text DEFAULT '' NOT NULL,
	`last_substantive_at` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
