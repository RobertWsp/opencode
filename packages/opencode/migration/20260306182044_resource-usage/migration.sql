CREATE TABLE `resource_usage` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_name` text NOT NULL,
	`call_count` integer NOT NULL,
	`total_latency_ms` integer NOT NULL,
	`last_used_at` integer,
	`date` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_resource_usage_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `resource_usage_project_id_idx` ON `resource_usage` (`project_id`);--> statement-breakpoint
CREATE INDEX `resource_usage_resource_name_idx` ON `resource_usage` (`resource_name`);--> statement-breakpoint
CREATE INDEX `resource_usage_date_idx` ON `resource_usage` (`date`);