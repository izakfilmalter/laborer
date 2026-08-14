INSERT INTO `task_changes` (`task_id`, `changed_at`, `mutation_id`)
SELECT `id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
FROM `tasks`
WHERE `source` = 'worktree'
	AND `status` = 'in_progress'
	AND `worktree_path` IS NULL;
--> statement-breakpoint
UPDATE `tasks`
SET `status` = 'done',
	`updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	`revision` = `revision` + 1
WHERE `source` = 'worktree'
	AND `status` = 'in_progress'
	AND `worktree_path` IS NULL;
