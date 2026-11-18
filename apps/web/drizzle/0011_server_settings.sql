-- Server-wide settings in one row. Sharing the folder that holds every home folder, or a folder above it, stays refused until an administrator allows it.
CREATE TABLE `nimbus_server_setting` (
	`id` integer PRIMARY KEY NOT NULL,
	`allow_home_container_sharing` integer DEFAULT false NOT NULL,
	`updated_at` integer,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "nimbus_server_setting_single_row" CHECK(id = 0)
);
--> statement-breakpoint
INSERT INTO `nimbus_server_setting` (`id`, `allow_home_container_sharing`) VALUES (0, 0);
