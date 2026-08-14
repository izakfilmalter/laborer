ALTER TABLE `tasks` ADD `pr_base_branch` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_merge_status` text CHECK (`pr_merge_status` IN ('clean', 'conflicting', 'unknown'));
--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_check_status` text CHECK (`pr_check_status` IN ('pending', 'success', 'failure'));
--> statement-breakpoint
ALTER TABLE `projects` ADD `branch_name` text;
