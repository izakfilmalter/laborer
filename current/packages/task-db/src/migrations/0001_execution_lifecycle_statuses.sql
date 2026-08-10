CREATE TABLE `tasks_execution_lifecycle` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL CHECK (`status` IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
	`source` text NOT NULL CHECK (`source` IN ('execution', 'manual', 'slack_url')),
	`execution_id` text,
	`action_name` text,
	`execution_status` text CHECK (`execution_status` IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-attention')),
	`slack_permalink` text,
	`worktree_path` text,
	`branch_name` text,
	`initial_prompt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL CHECK (`revision` >= 1)
);
--> statement-breakpoint
INSERT INTO `tasks_execution_lifecycle` SELECT * FROM `tasks`;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
ALTER TABLE `tasks_execution_lifecycle` RENAME TO `tasks`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_execution_id_unique` ON `tasks` (`execution_id`);
