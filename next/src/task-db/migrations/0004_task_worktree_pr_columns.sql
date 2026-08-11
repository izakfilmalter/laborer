ALTER TABLE `tasks` ADD `worktree_status` text CHECK (`worktree_status` IN ('provisioning', 'ready', 'errored'));
--> statement-breakpoint
ALTER TABLE `tasks` ADD `worktree_error` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `setup_completed_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_task_id` text REFERENCES `tasks`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `base_sha` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `base_branch` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_number` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_url` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_title` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_state` text CHECK (`pr_state` IN ('open', 'closed', 'merged'));
--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_is_draft` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `sort_order` real;
--> statement-breakpoint
ALTER TABLE `task_changes` ADD `mutation_id` text;
--> statement-breakpoint
CREATE INDEX `tasks_parent_task_id_index` ON `tasks` (`parent_task_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_worktree_path_unique` ON `tasks` (`worktree_path`) WHERE `worktree_path` IS NOT NULL;
