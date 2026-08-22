CREATE TABLE IF NOT EXISTS `app_user_role_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_user_id` integer NOT NULL,
	`actor_user_id` integer NOT NULL,
	`request_id` text NOT NULL,
	`from_role` text NOT NULL,
	`to_role` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`target_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_app_user_role_events_target` ON `app_user_role_events` (`target_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_app_user_role_events_actor` ON `app_user_role_events` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_app_user_role_events_request` ON `app_user_role_events` (`request_id`);
