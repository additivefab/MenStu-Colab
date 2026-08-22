CREATE TABLE `student_feishu_identity_bindings` (
	`student_id` text PRIMARY KEY NOT NULL,
	`feishu_open_id` text NOT NULL,
	`batch_id` integer NOT NULL,
	`verified_by_user_id` integer NOT NULL,
	`verification_method` text DEFAULT 'feishu_contact_batch_get_id' NOT NULL,
	`contact_kind` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `student_identity_binding_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "student_identity_bindings_contact_kind" CHECK("student_feishu_identity_bindings"."contact_kind" IN ('email', 'mobile', 'existing_login'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_student_identity_bindings_open_id` ON `student_feishu_identity_bindings` (`feishu_open_id`);--> statement-breakpoint
CREATE INDEX `idx_student_identity_bindings_batch` ON `student_feishu_identity_bindings` (`batch_id`);--> statement-breakpoint
CREATE TABLE `student_identity_binding_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` integer NOT NULL,
	`request_id` text NOT NULL,
	`record_count` integer NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "student_identity_binding_batches_record_count" CHECK("student_identity_binding_batches"."record_count" = 26)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_student_identity_binding_batches_request` ON `student_identity_binding_batches` (`request_id`);
