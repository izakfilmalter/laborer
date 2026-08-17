ALTER TABLE `task_changes` RENAME COLUMN `mutation_id` TO `operation_id`;
--> statement-breakpoint
ALTER TABLE `state_changes` RENAME COLUMN `mutation_id` TO `operation_id`;
--> statement-breakpoint
CREATE INDEX `task_changes_operation_id_idx` ON `task_changes` (`operation_id`);
--> statement-breakpoint
CREATE INDEX `state_changes_operation_id_idx` ON `state_changes` (`operation_id`);
