ALTER TABLE `tasks` ADD COLUMN `label_ids` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL CHECK (`revision` >= 1),
	CONSTRAINT `labels_color_check` CHECK (`color` IN ('red', 'orange', 'amber', 'emerald', 'teal', 'blue', 'violet', 'pink'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name_unique` ON `labels` (lower(`name`));
--> statement-breakpoint
INSERT INTO `labels` (`id`, `name`, `color`, `created_at`, `updated_at`, `revision`) VALUES
	('01KDVDNA00DEFA0000000000FE', 'FE', 'blue', unixepoch() * 1000, unixepoch() * 1000, 1),
	('01KDVDNA00DEFA0000000000BE', 'BE', 'violet', unixepoch() * 1000, unixepoch() * 1000, 1),
	('01KDVDNA00DEFA00000000FSTK', 'Full Stack', 'emerald', unixepoch() * 1000, unixepoch() * 1000, 1);
