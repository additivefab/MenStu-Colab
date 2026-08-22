CREATE TABLE `progress_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`progress_entry_id` integer NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_sha256` text NOT NULL,
	`uploaded_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_progress_attachments_storage_key` ON `progress_attachments` (`storage_key`);--> statement-breakpoint
CREATE INDEX `idx_progress_attachments_entry_created` ON `progress_attachments` (`progress_entry_id`,`created_at`);