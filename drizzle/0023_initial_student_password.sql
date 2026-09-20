CREATE TABLE `local_login_rollouts` (
	`rollout_key` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `local_credentials` ADD `must_change_password` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
INSERT INTO app_schema_meta (id, version, updated_at) VALUES (1, 23, CURRENT_TIMESTAMP)
ON CONFLICT(id) DO UPDATE SET version = MAX(app_schema_meta.version, excluded.version), updated_at = CURRENT_TIMESTAMP;
