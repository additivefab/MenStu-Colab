ALTER TABLE `local_credentials` ADD `authorized_role` text DEFAULT 'student' NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_local_credentials` (
	`app_user_id` integer PRIMARY KEY NOT NULL,
	`student_id` text,
	`authorized_role` text DEFAULT 'student' NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`must_change_password` integer DEFAULT 0 NOT NULL,
	`activation_hash` text,
	`activation_expires_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`app_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "local_credentials_version" CHECK("__new_local_credentials"."version" >= 1),
	CONSTRAINT "local_credentials_role" CHECK("__new_local_credentials"."authorized_role" IN ('student', 'admin', 'superadmin'))
);
--> statement-breakpoint
INSERT INTO `__new_local_credentials`("app_user_id", "student_id", "authorized_role", "username", "password_hash", "must_change_password", "activation_hash", "activation_expires_at", "version", "updated_at") SELECT "app_user_id", "student_id", "authorized_role", "username", "password_hash", "must_change_password", "activation_hash", "activation_expires_at", "version", "updated_at" FROM `local_credentials`;--> statement-breakpoint
DROP TABLE `local_credentials`;--> statement-breakpoint
ALTER TABLE `__new_local_credentials` RENAME TO `local_credentials`;--> statement-breakpoint
CREATE UNIQUE INDEX `local_credentials_username_unique` ON `local_credentials` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_credentials_activation_hash_unique` ON `local_credentials` (`activation_hash`);
--> statement-breakpoint
INSERT INTO app_schema_meta (id, version, updated_at) VALUES (1, 24, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET version = MAX(app_schema_meta.version, excluded.version), updated_at = CURRENT_TIMESTAMP;
