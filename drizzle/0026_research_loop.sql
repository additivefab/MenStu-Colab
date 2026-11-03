CREATE TABLE `agent_attempt_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `agent_attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_attempt_events_seq` ON `agent_attempt_events` (`attempt_id`,`sequence`);
--> statement-breakpoint
CREATE TABLE `agent_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`task_version` integer NOT NULL,
	`student_id` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text DEFAULT '' NOT NULL,
	`sdk_version` text DEFAULT '' NOT NULL,
	`credential_profile_id` text NOT NULL,
	`github_repository_id` integer NOT NULL,
	`base_commit_sha` text NOT NULL,
	`context_snapshot_sha256` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`worker_id` text,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` text,
	`heartbeat_at` text,
	`idempotency_key` text NOT NULL,
	`diff_sha256` text,
	`diff_r2_key` text,
	`changed_paths_json` text DEFAULT '[]' NOT NULL,
	`tests_json` text DEFAULT '[]' NOT NULL,
	`usage_json` text DEFAULT '{}' NOT NULL,
	`error_code` text DEFAULT '' NOT NULL,
	`error_message` text DEFAULT '' NOT NULL,
	`requested_by_user_id` integer NOT NULL,
	`cancel_requested_at` text,
	`cancel_requested_by_user_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`ended_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_profile_id`) REFERENCES `agent_credential_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `lab_runners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancel_requested_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_attempt_provider" CHECK("agent_attempts"."provider" IN ('codex', 'claude', 'deepseek')),
	CONSTRAINT "agent_attempt_status" CHECK("agent_attempts"."status" IN ('queued', 'running', 'waiting_approval', 'change_ready', 'failed', 'cancel_requested', 'canceled')),
	CONSTRAINT "agent_attempt_sha" CHECK(length("agent_attempts"."base_commit_sha") = 40)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_attempts_idempotency_key_unique` ON `agent_attempts` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_agent_attempts_task` ON `agent_attempts` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_agent_attempts_queue` ON `agent_attempts` (`status`,`created_at`);
--> statement-breakpoint
CREATE TABLE `agent_credential_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`worker_id` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker_id`) REFERENCES `lab_runners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_credential_provider" CHECK("agent_credential_profiles"."provider" IN ('codex', 'claude', 'deepseek')),
	CONSTRAINT "agent_credential_active" CHECK("agent_credential_profiles"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_credential_user_provider` ON `agent_credential_profiles` (`user_id`,`provider`);
--> statement-breakpoint
CREATE TABLE `change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`student_id` text NOT NULL,
	`github_repository_id` integer NOT NULL,
	`base_commit_sha` text NOT NULL,
	`branch_name` text NOT NULL,
	`head_commit_sha` text,
	`pr_number` integer,
	`pr_url` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`requires_extra_review` integer DEFAULT 0 NOT NULL,
	`extra_review_approved_by_user_id` integer,
	`extra_review_approved_at` text,
	`published_by_user_id` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `agent_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extra_review_approved_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`published_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "change_request_status" CHECK("change_requests"."status" IN ('pending_review', 'publishing', 'open', 'merged', 'closed', 'rejected', 'failed')),
	CONSTRAINT "change_request_extra_review" CHECK("change_requests"."requires_extra_review" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_requests_attempt_id_unique` ON `change_requests` (`attempt_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_change_requests_branch` ON `change_requests` (`github_repository_id`,`branch_name`);
--> statement-breakpoint
CREATE INDEX `idx_change_requests_pr` ON `change_requests` (`github_repository_id`,`pr_number`);
--> statement-breakpoint
CREATE TABLE `dataset_grants` (
	`dataset_version_id` text NOT NULL,
	`student_id` text NOT NULL,
	`granted_by_user_id` integer NOT NULL,
	`granted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	`revoked_by_user_id` integer,
	FOREIGN KEY (`dataset_version_id`) REFERENCES `dataset_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`granted_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dataset_grants_pk` ON `dataset_grants` (`dataset_version_id`,`student_id`);
--> statement-breakpoint
CREATE TABLE `dataset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`runner_id` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`split_manifest_sha256` text DEFAULT '' NOT NULL,
	`egress_policy_json` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`runner_id`) REFERENCES `lab_runners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "dataset_version_active" CHECK("dataset_versions"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `github_installations` (
	`installation_id` integer PRIMARY KEY NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text DEFAULT 'selected' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "github_installation_status" CHECK("github_installations"."status" IN ('active', 'suspended', 'deleted')),
	CONSTRAINT "github_installation_selection" CHECK("github_installations"."repository_selection" IN ('all', 'selected'))
);
--> statement-breakpoint
CREATE TABLE `github_webhook_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`action` text DEFAULT '' NOT NULL,
	`installation_id` integer,
	`repository_id` integer,
	`payload_sha256` text NOT NULL,
	`summary_json` text DEFAULT '{}' NOT NULL,
	`origin` text DEFAULT 'external' NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`processed_at` text,
	CONSTRAINT "github_webhook_origin" CHECK("github_webhook_deliveries"."origin" IN ('external', 'platform_echo')),
	CONSTRAINT "github_webhook_status" CHECK("github_webhook_deliveries"."status" IN ('received', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_github_webhook_status` ON `github_webhook_deliveries` (`status`,`received_at`);
--> statement-breakpoint
CREATE TABLE `lab_runners` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`token_sha256` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seen_at` text,
	`created_by_user_id` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lab_runner_kind" CHECK("lab_runners"."kind" IN ('compute', 'agent')),
	CONSTRAINT "lab_runner_status" CHECK("lab_runners"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lab_runners_token_sha256_unique` ON `lab_runners` (`token_sha256`);
--> statement-breakpoint
CREATE TABLE `registered_entrypoints` (
	`id` text PRIMARY KEY NOT NULL,
	`github_repository_id` integer NOT NULL,
	`name` text NOT NULL,
	`argv_json` text NOT NULL,
	`params_schema_json` text DEFAULT '{}' NOT NULL,
	`image_ref` text NOT NULL,
	`evaluation_protocol_sha256` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "registered_entrypoint_active" CHECK("registered_entrypoints"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_registered_entrypoints_repository` ON `registered_entrypoints` (`github_repository_id`);
--> statement-breakpoint
CREATE TABLE `repository_links` (
	`student_id` text PRIMARY KEY NOT NULL,
	`github_repository_id` integer NOT NULL,
	`installation_id` integer NOT NULL,
	`full_name` text NOT NULL,
	`default_branch` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`verified_by_user_id` integer,
	`verified_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installation_id`) REFERENCES `github_installations`(`installation_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "repository_link_status" CHECK("repository_links"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_repository_links_repository` ON `repository_links` (`github_repository_id`);
--> statement-breakpoint
CREATE TABLE `research_task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`action` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_user_id` integer,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "research_task_event_action" CHECK("research_task_events"."action" IN ('created', 'revised', 'confirmed', 'closed', 'canceled')),
	CONSTRAINT "research_task_event_actor" CHECK("research_task_events"."actor_type" IN ('user', 'system'))
);
--> statement-breakpoint
CREATE INDEX `idx_research_task_events_task` ON `research_task_events` (`task_id`,`id`);
--> statement-breakpoint
CREATE TABLE `research_task_versions` (
	`task_id` text NOT NULL,
	`version` integer NOT NULL,
	`research_question` text NOT NULL,
	`hypothesis` text DEFAULT '' NOT NULL,
	`instructions` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`allowed_paths_json` text DEFAULT '[]' NOT NULL,
	`protected_paths_json` text DEFAULT '[]' NOT NULL,
	`budget_json` text DEFAULT '{}' NOT NULL,
	`snapshot_sha256` text NOT NULL,
	`author_user_id` integer NOT NULL,
	`confirmed_by_user_id` integer,
	`confirmed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "research_task_versions_version" CHECK("research_task_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_research_task_versions_pk` ON `research_task_versions` (`task_id`,`version`);
--> statement-breakpoint
CREATE TABLE `research_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`source_guidance_note_id` integer,
	`source_run_id` text,
	`parent_task_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`confirmed_version` integer,
	`created_by_user_id` integer NOT NULL,
	`last_mutation_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_guidance_note_id`) REFERENCES `student_guidance_notes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "research_task_status" CHECK("research_tasks"."status" IN ('draft', 'confirmed', 'closed', 'canceled')),
	CONSTRAINT "research_task_version" CHECK("research_tasks"."current_version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_tasks_last_mutation_id_unique` ON `research_tasks` (`last_mutation_id`);
--> statement-breakpoint
CREATE INDEX `idx_research_tasks_student` ON `research_tasks` (`student_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `result_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`author_user_id` integer NOT NULL,
	`parent_comment_id` integer,
	`body` text NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `result_comments_request_id_unique` ON `result_comments` (`request_id`);
--> statement-breakpoint
CREATE INDEX `idx_result_comments_run` ON `result_comments` (`run_id`,`id`);
--> statement-breakpoint
CREATE TABLE `result_reviews` (
	`run_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`hypothesis_outcome` text DEFAULT 'not_assessed' NOT NULL,
	`reviewer_user_id` integer,
	`note` text DEFAULT '' NOT NULL,
	`followup_task_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`followup_task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "result_review_state" CHECK("result_reviews"."state" IN ('pending', 'accepted', 'rejected', 'needs_followup')),
	CONSTRAINT "result_review_hypothesis" CHECK("result_reviews"."hypothesis_outcome" IN ('not_assessed', 'supported', 'not_supported', 'inconclusive', 'not_applicable'))
);
--> statement-breakpoint
CREATE TABLE `run_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_spec_sha256` text NOT NULL,
	`approved_by_user_id` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`approved_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	`revoked_by_user_id` integer,
	FOREIGN KEY (`run_spec_sha256`) REFERENCES `run_specs`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_run_approvals_spec` ON `run_approvals` (`run_spec_sha256`,`approved_at`);
--> statement-breakpoint
CREATE TABLE `run_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`relative_path` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`kind` text NOT NULL,
	`egress_decision` text NOT NULL,
	`egress_reason` text DEFAULT '' NOT NULL,
	`r2_key` text,
	`lab_locator` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_artifact_kind" CHECK("run_artifacts"."kind" IN ('metrics', 'figure', 'table', 'log', 'model', 'other')),
	CONSTRAINT "run_artifact_egress" CHECK("run_artifacts"."egress_decision" IN ('published', 'held', 'rejected')),
	CONSTRAINT "run_artifact_size" CHECK("run_artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_artifacts_path` ON `run_artifacts` (`run_id`,`relative_path`);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`from_status` text DEFAULT '' NOT NULL,
	`to_status` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text DEFAULT '' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_event_actor" CHECK("run_events"."actor_type" IN ('user', 'runner', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_run_events_seq` ON `run_events` (`run_id`,`sequence`);
--> statement-breakpoint
CREATE TABLE `run_results` (
	`run_id` text PRIMARY KEY NOT NULL,
	`manifest_sha256` text NOT NULL,
	`manifest_json` text NOT NULL,
	`metrics_json` text,
	`metrics_source_artifact_id` text,
	`technical_validity` text DEFAULT 'unknown' NOT NULL,
	`validity_notes` text DEFAULT '' NOT NULL,
	`report_commit_sha` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`metrics_source_artifact_id`) REFERENCES `run_artifacts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_result_validity" CHECK("run_results"."technical_validity" IN ('valid', 'invalid', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE `run_specs` (
	`sha256` text PRIMARY KEY NOT NULL,
	`canonical_json` text NOT NULL,
	`task_id` text NOT NULL,
	`task_version` integer NOT NULL,
	`student_id` text NOT NULL,
	`github_repository_id` integer NOT NULL,
	`executed_commit_sha` text NOT NULL,
	`entrypoint_id` text NOT NULL,
	`dataset_version_id` text NOT NULL,
	`change_request_id` text,
	`created_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entrypoint_id`) REFERENCES `registered_entrypoints`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dataset_version_id`) REFERENCES `dataset_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`change_request_id`) REFERENCES `change_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_spec_sha" CHECK(length("run_specs"."executed_commit_sha") = 40)
);
--> statement-breakpoint
CREATE INDEX `idx_run_specs_task` ON `run_specs` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_spec_sha256` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`approval_id` text,
	`task_id` text NOT NULL,
	`student_id` text NOT NULL,
	`status` text DEFAULT 'awaiting_approval' NOT NULL,
	`idempotency_key` text NOT NULL,
	`submit_tag` text NOT NULL,
	`runner_id` text,
	`lease_epoch` integer DEFAULT 0 NOT NULL,
	`lease_expires_at` text,
	`heartbeat_at` text,
	`scheduler_job_id` text,
	`exit_code` integer,
	`failure_reason` text DEFAULT '' NOT NULL,
	`cancel_requested_at` text,
	`cancel_requested_by_user_id` integer,
	`created_by_user_id` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`queued_at` text,
	`started_at` text,
	`ended_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_spec_sha256`) REFERENCES `run_specs`(`sha256`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `run_approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `research_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_id`) REFERENCES `lab_runners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancel_requested_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_status" CHECK("runs"."status" IN ('awaiting_approval', 'queued', 'dispatching', 'running', 'collecting', 'completed', 'failed', 'cancel_requested', 'canceled', 'reconciling')),
	CONSTRAINT "run_attempt" CHECK("runs"."attempt" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_idempotency_key_unique` ON `runs` (`idempotency_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_submit_tag_unique` ON `runs` (`submit_tag`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_runs_spec_attempt` ON `runs` (`run_spec_sha256`,`attempt`);
--> statement-breakpoint
CREATE INDEX `idx_runs_queue` ON `runs` (`status`,`queued_at`);
--> statement-breakpoint
CREATE INDEX `idx_runs_task` ON `runs` (`task_id`,`created_at`);
