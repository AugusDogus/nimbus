CREATE TABLE `nimbus_file_request_upload` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`name` text,
	FOREIGN KEY (`request_id`) REFERENCES `nimbus_file_request`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nimbus_file_request_upload_request` ON `nimbus_file_request_upload` (`request_id`);--> statement-breakpoint
CREATE TABLE `nimbus_file_request` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`path` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`password_hash` text,
	`note` text,
	`max_file_bytes` integer,
	`max_files` integer,
	`max_total_bytes` integer,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_file_request_token_unique` ON `nimbus_file_request` (`token`);--> statement-breakpoint
ALTER TABLE `nimbus_share` ADD `max_downloads` integer;--> statement-breakpoint
ALTER TABLE `nimbus_share` ADD `mode` text DEFAULT 'download' NOT NULL;