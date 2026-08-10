CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`root_path` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`execution_id` text,
	`action_name` text,
	`execution_status` text,
	`slack_permalink` text,
	`worktree_path` text,
	`branch_name` text,
	`initial_prompt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_execution_id_unique` ON `tasks` (`execution_id`);
--> statement-breakpoint
CREATE TABLE `task_changes` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`changed_at` integer NOT NULL
);
