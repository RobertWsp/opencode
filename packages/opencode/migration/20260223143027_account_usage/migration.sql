CREATE TABLE `account_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`account_index` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`token_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`cooldown_until` integer,
	`disabled` integer DEFAULT 0 NOT NULL,
	`switch_count` integer DEFAULT 0 NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
