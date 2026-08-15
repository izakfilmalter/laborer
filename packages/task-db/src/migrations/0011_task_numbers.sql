ALTER TABLE `tasks` ADD `task_number` integer;

UPDATE `tasks`
SET `task_number` = 1 + (
  SELECT COUNT(*)
  FROM `tasks` AS `earlier`
  WHERE `earlier`.`root_path` = `tasks`.`root_path`
    AND (
      `earlier`.`created_at` < `tasks`.`created_at`
      OR (
        `earlier`.`created_at` = `tasks`.`created_at`
        AND `earlier`.`id` < `tasks`.`id`
      )
    )
);

CREATE UNIQUE INDEX `tasks_root_path_task_number_unique`
ON `tasks` (`root_path`, `task_number`);

CREATE TABLE `task_number_counters` (
  `root_path` text PRIMARY KEY NOT NULL,
  `next_number` integer NOT NULL CHECK (`next_number` >= 1)
);

INSERT INTO `task_number_counters` (`root_path`, `next_number`)
SELECT `root_path`, MAX(`task_number`) + 1
FROM `tasks`
GROUP BY `root_path`;

CREATE TRIGGER `tasks_assign_task_number`
AFTER INSERT ON `tasks`
WHEN NEW.`task_number` IS NULL
BEGIN
  INSERT INTO `task_number_counters` (`root_path`, `next_number`)
  VALUES (NEW.`root_path`, 2)
  ON CONFLICT (`root_path`) DO UPDATE
  SET `next_number` = `next_number` + 1;

  UPDATE `tasks`
  SET `task_number` = (
    SELECT `next_number` - 1
    FROM `task_number_counters`
    WHERE `root_path` = NEW.`root_path`
  )
  WHERE `id` = NEW.`id`;
END;
