CREATE TABLE `progress_deletions` (
	`progress_entry_id` integer PRIMARY KEY NOT NULL,
	`deleted_by_user_id` integer NOT NULL,
	`deleted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`operation_id` text NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deleted_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS protect_deleted_progress
  BEFORE UPDATE ON progress_entries
  WHEN EXISTS (SELECT 1 FROM progress_deletions WHERE progress_entry_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'AI_RECORD_DELETED'); END;
--> statement-breakpoint
INSERT INTO app_schema_meta (id, version, updated_at) VALUES (1, 20, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET version = MAX(app_schema_meta.version, excluded.version), updated_at = CURRENT_TIMESTAMP;
