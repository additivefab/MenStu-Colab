CREATE TABLE `agent_attempt_plans` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`plan_text` text DEFAULT '' NOT NULL,
	`plan_sha256` text DEFAULT '' NOT NULL,
	`decision` text DEFAULT 'awaiting_plan' NOT NULL,
	`submitted_at` text,
	`decided_by_user_id` integer,
	`decided_at` text,
	`note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `agent_attempts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_attempt_plan_decision" CHECK("agent_attempt_plans"."decision" IN ('awaiting_plan', 'pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE `loop_notifications` (
	`event_key` text NOT NULL,
	`recipient_user_id` integer NOT NULL,
	`channel` text DEFAULT 'feishu' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "loop_notification_status" CHECK("loop_notifications"."status" IN ('pending', 'sent', 'skipped', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_loop_notifications_pk` ON `loop_notifications` (`event_key`,`recipient_user_id`,`channel`);
--> statement-breakpoint
CREATE TABLE `result_interpretations` (
	`run_id` text NOT NULL,
	`version` integer NOT NULL,
	`author_user_id` integer NOT NULL,
	`what_it_shows` text NOT NULL,
	`alternative_explanations` text DEFAULT '' NOT NULL,
	`limitations` text DEFAULT '' NOT NULL,
	`proposed_next_step` text DEFAULT '' NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "result_interpretation_version" CHECK("result_interpretations"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `result_interpretations_request_id_unique` ON `result_interpretations` (`request_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_result_interpretations_pk` ON `result_interpretations` (`run_id`,`version`);
--> statement-breakpoint
CREATE TABLE `review_delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`reviewer_user_id` integer NOT NULL,
	`delegated_by_user_id` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`revoked_at` text,
	`revoked_by_user_id` integer,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delegated_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_delegation_active" CHECK("review_delegations"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_review_delegations_reviewer` ON `review_delegations` (`reviewer_user_id`,`active`);
--> statement-breakpoint
CREATE INDEX `idx_review_delegations_student` ON `review_delegations` (`student_id`,`active`);
--> statement-breakpoint
CREATE TABLE `run_baselines` (
	`run_id` text PRIMARY KEY NOT NULL,
	`baseline_run_id` text NOT NULL,
	`set_by_user_id` integer NOT NULL,
	`set_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`baseline_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`set_by_user_id`) REFERENCES `app_users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "run_baseline_not_self" CHECK("run_baselines"."run_id" <> "run_baselines"."baseline_run_id")
);
