CREATE TABLE `tasks_worktree_source` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL CHECK (`status` IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
	`source` text NOT NULL CHECK (`source` IN ('execution', 'manual', 'slack_url', 'agent', 'worktree')),
	`execution_id` text,
	`action_name` text,
	`execution_status` text CHECK (`execution_status` IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-attention')),
	`slack_permalink` text,
	`worktree_path` text,
	`branch_name` text,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL CHECK (`revision` >= 1)
);
--> statement-breakpoint
INSERT INTO `tasks_worktree_source` (
	`id`, `root_path`, `title`, `status`, `source`, `execution_id`, `action_name`,
	`execution_status`, `slack_permalink`, `worktree_path`, `branch_name`,
	`description`, `created_at`, `updated_at`, `revision`
) SELECT
	`id`, `root_path`, `title`, `status`, `source`, `execution_id`, `action_name`,
	`execution_status`, `slack_permalink`, `worktree_path`, `branch_name`,
	`description`, `created_at`, `updated_at`, `revision`
FROM `tasks`;
--> statement-breakpoint
DROP TABLE `tasks`;
--> statement-breakpoint
ALTER TABLE `tasks_worktree_source` RENAME TO `tasks`;
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_execution_id_unique` ON `tasks` (`execution_id`);
