CREATE TABLE `proposal_audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` integer NOT NULL,
	`actor_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `research_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_proposal_audit_proposal_created` ON `proposal_audit_events` (`proposal_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `research_milestones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` integer NOT NULL,
	`title` text NOT NULL,
	`target_date` text NOT NULL,
	`evidence_target` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `research_proposals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_research_milestones_proposal_order` ON `research_milestones` (`proposal_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `research_proposal_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proposal_id` integer NOT NULL,
	`version_number` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`submitted_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`proposal_id`) REFERENCES `research_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submitted_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_proposal_versions_proposal_number` ON `research_proposal_versions` (`proposal_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_proposal_versions_created` ON `research_proposal_versions` (`proposal_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `research_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`student_id` text NOT NULL,
	`title` text DEFAULT '未命名方案' NOT NULL,
	`scientific_question` text DEFAULT '' NOT NULL,
	`hypothesis` text DEFAULT '' NOT NULL,
	`objectives` text DEFAULT '' NOT NULL,
	`innovation` text DEFAULT '' NOT NULL,
	`literature_basis` text DEFAULT '' NOT NULL,
	`methodology` text DEFAULT '' NOT NULL,
	`data_ethics` text DEFAULT '' NOT NULL,
	`risks` text DEFAULT '' NOT NULL,
	`resources` text DEFAULT '' NOT NULL,
	`references_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`reviewer_note` text DEFAULT '' NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`submitted_at` text,
	`approved_at` text,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_research_proposals_student_unique` ON `research_proposals` (`student_id`);--> statement-breakpoint
CREATE INDEX `idx_research_proposals_status_updated` ON `research_proposals` (`status`,`updated_at`);--> statement-breakpoint
PRAGMA optimize;
