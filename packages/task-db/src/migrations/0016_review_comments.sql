CREATE TABLE `review_comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`file_path` text NOT NULL,
	`side` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL CHECK (`revision` >= 1),
	CONSTRAINT `review_comment_threads_side_check` CHECK (`side` IN ('additions', 'deletions')),
	CONSTRAINT `review_comment_threads_status_check` CHECK (`status` IN ('open', 'resolved')),
	CONSTRAINT `review_comment_threads_line_range_check` CHECK (`start_line` >= 1 AND `end_line` >= `start_line`)
);
--> statement-breakpoint
CREATE INDEX `review_comment_threads_workspace_id_idx` ON `review_comment_threads` (`workspace_id`);
--> statement-breakpoint
CREATE TABLE `review_comment_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL REFERENCES `review_comment_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `review_comment_replies_author_check` CHECK (`author` IN ('human', 'agent'))
);
--> statement-breakpoint
CREATE INDEX `review_comment_replies_thread_id_idx` ON `review_comment_replies` (`thread_id`, `created_at`, `id`);
