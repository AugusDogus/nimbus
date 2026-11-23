CREATE TABLE `nimbus_auth_rate_limit` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nimbus_auth_rate_limit_end` ON `nimbus_auth_rate_limit` (`window_end`);--> statement-breakpoint
CREATE TABLE `nimbus_guess_budget` (
	`name` text NOT NULL,
	`key` text NOT NULL,
	`tat` integer NOT NULL,
	PRIMARY KEY(`name`, `key`)
);
--> statement-breakpoint
CREATE INDEX `nimbus_guess_budget_tat` ON `nimbus_guess_budget` (`tat`);--> statement-breakpoint
CREATE TABLE `nimbus_spent_code` (
	`key` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nimbus_spent_code_expiry` ON `nimbus_spent_code` (`expires_at`);