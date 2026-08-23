CREATE TABLE `progress_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`progress_entry_id` integer NOT NULL,
	`revision_number` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`submitted_by_user_id` integer,
	`review_status` text DEFAULT 'submitted' NOT NULL,
	`assessment` text,
	`reviewer_note` text DEFAULT '' NOT NULL,
	`reviewed_by_user_id` integer,
	`reviewed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_progress_revisions_entry_number` ON `progress_revisions` (`progress_entry_id`,`revision_number`);--> statement-breakpoint
CREATE INDEX `idx_progress_revisions_entry_created` ON `progress_revisions` (`progress_entry_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_progress_details` (
	`progress_entry_id` integer PRIMARY KEY NOT NULL,
	`milestone_id` integer,
	`milestone_title` text DEFAULT '' NOT NULL,
	`milestone_target_date` text,
	`evidence_target` text DEFAULT '' NOT NULL,
	`proposal_version` integer,
	`next_action` text NOT NULL,
	`next_action_due_date` text NOT NULL,
	`blocker` text DEFAULT '' NOT NULL,
	`completion_requested` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`progress_entry_id`) REFERENCES `progress_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`milestone_id`) REFERENCES `research_milestones`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_progress_completion_requested" CHECK("project_progress_details"."completion_requested" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_project_progress_milestone_created` ON `project_progress_details` (`milestone_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_project_progress_due` ON `project_progress_details` (`next_action_due_date`);--> statement-breakpoint
ALTER TABLE `progress_attachments` ADD `revision_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_progress_attachments_entry_revision` ON `progress_attachments` (`progress_entry_id`,`revision_number`);--> statement-breakpoint
ALTER TABLE `progress_entries` ADD `current_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `progress_evidence_sources` ADD `revision_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_progress_evidence_entry_revision` ON `progress_evidence_sources` (`progress_entry_id`,`revision_number`);--> statement-breakpoint
ALTER TABLE `research_milestones` ADD `archived_at` text;--> statement-breakpoint
INSERT INTO `progress_revisions`
  (`progress_entry_id`, `revision_number`, `snapshot_json`, `submitted_by_user_id`,
   `review_status`, `assessment`, `reviewer_note`, `reviewed_by_user_id`, `reviewed_at`, `created_at`)
SELECT p.`id`, 1,
  json_object(
    'kind', p.`kind`,
    'title', p.`title`,
    'summary', p.`summary`,
    'evidence', p.`evidence`,
    'literatureRef', p.`literature_ref`,
    'gitUrl', p.`git_url`,
    'attachments', json_array(),
    'paper', NULL,
    'project', NULL
  ),
  CASE WHEN EXISTS (
    SELECT 1 FROM `app_users` submitter WHERE submitter.`id` = p.`submitted_by_user_id`
  ) THEN p.`submitted_by_user_id` ELSE NULL END,
  p.`review_status`, p.`assessment`, p.`reviewer_note`,
  CASE WHEN EXISTS (
    SELECT 1 FROM `app_users` reviewer WHERE reviewer.`id` = p.`reviewed_by_user_id`
  ) THEN p.`reviewed_by_user_id` ELSE NULL END,
  p.`reviewed_at`, p.`submitted_at`
FROM `progress_entries` p
WHERE NOT EXISTS (
  SELECT 1 FROM `progress_revisions` r WHERE r.`progress_entry_id` = p.`id`
);--> statement-breakpoint
INSERT INTO `app_schema_meta` (`id`, `version`, `updated_at`)
VALUES (1, 17, CURRENT_TIMESTAMP)
ON CONFLICT(`id`) DO UPDATE SET `version` = excluded.`version`, `updated_at` = CURRENT_TIMESTAMP;
