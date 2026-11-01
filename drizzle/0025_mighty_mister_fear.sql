CREATE TABLE `student_repository_bindings` (
	`student_id` text PRIMARY KEY NOT NULL,
	`github_username` text NOT NULL,
	`repository_url` text NOT NULL,
	`repository_full_name` text NOT NULL,
	`visibility` text DEFAULT 'unknown' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`last_mutation_id` text NOT NULL,
	`created_by_user_id` integer,
	`updated_by_user_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "student_repository_visibility" CHECK("student_repository_bindings"."visibility" IN ('private', 'public', 'unknown')),
	CONSTRAINT "student_repository_active" CHECK("student_repository_bindings"."active" IN (0, 1)),
	CONSTRAINT "student_repository_version" CHECK("student_repository_bindings"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_student_repository_mutation` ON `student_repository_bindings` (`last_mutation_id`);--> statement-breakpoint
CREATE TABLE `student_repository_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`version` integer NOT NULL,
	`action` text NOT NULL,
	`actor_user_id` integer,
	`actor_type` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "student_repository_event_action" CHECK("student_repository_events"."action" IN ('created', 'updated', 'unlinked')),
	CONSTRAINT "student_repository_event_actor" CHECK("student_repository_events"."actor_type" IN ('user', 'system')),
	CONSTRAINT "student_repository_event_version" CHECK("student_repository_events"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_student_repository_event_version` ON `student_repository_events` (`student_id`,`version`);--> statement-breakpoint
CREATE TABLE `student_repository_rollouts` (
	`rollout_key` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
