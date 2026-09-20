CREATE TABLE `local_auth_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `local_auth_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app_user_id` integer NOT NULL,
	`actor_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`app_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "local_auth_events_action" CHECK("local_auth_events"."action" IN ('issue', 'activate', 'disable', 'change_password'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_auth_events_request_id_unique` ON `local_auth_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `local_credentials` (
	`app_user_id` integer PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`activation_hash` text,
	`activation_expires_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`app_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "local_credentials_version" CHECK("local_credentials"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_credentials_username_unique` ON `local_credentials` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_credentials_activation_hash_unique` ON `local_credentials` (`activation_hash`);--> statement-breakpoint
ALTER TABLE `app_sessions` ADD `auth_method` text DEFAULT 'feishu' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_sessions` ADD `local_credential_version` integer;--> statement-breakpoint
ALTER TABLE `app_sessions` ADD `local_student_id` text;
--> statement-breakpoint
INSERT INTO app_schema_meta (id, version, updated_at) VALUES (1, 22, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET version = MAX(app_schema_meta.version, excluded.version), updated_at = CURRENT_TIMESTAMP;
