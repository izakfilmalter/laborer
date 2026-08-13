CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root_path` text NOT NULL,
	`repo_id` text NOT NULL UNIQUE,
	`canonical_git_common_dir` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL CHECK (`revision` >= 1)
);
--> statement-breakpoint
CREATE INDEX `projects_root_path_index` ON `projects` (`root_path`);
