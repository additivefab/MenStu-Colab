CREATE TABLE `app_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`app_user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`app_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_app_sessions_user` ON `app_sessions` (`app_user_id`);--> statement-breakpoint
CREATE INDEX `idx_app_sessions_expires` ON `app_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `app_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feishu_open_id` text NOT NULL,
	`feishu_union_id` text DEFAULT '' NOT NULL,
	`feishu_user_id` text DEFAULT '' NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'pending' NOT NULL,
	`student_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_login_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_app_users_feishu_open_id` ON `app_users` (`feishu_open_id`);--> statement-breakpoint
CREATE INDEX `idx_app_users_role` ON `app_users` (`role`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_app_users_student_id_unique` ON `app_users` (`student_id`);