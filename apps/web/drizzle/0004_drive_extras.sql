ALTER TABLE `nimbus_share` ADD `max_downloads` integer;--> statement-breakpoint
ALTER TABLE `nimbus_share` ADD `mode` text DEFAULT 'download' NOT NULL;