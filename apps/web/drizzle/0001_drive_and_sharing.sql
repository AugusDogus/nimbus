ALTER TABLE `user` ADD `role` text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user` ADD `banned` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `user` ADD `ban_reason` text;
--> statement-breakpoint
ALTER TABLE `user` ADD `ban_expires` integer;
--> statement-breakpoint
ALTER TABLE `session` ADD `impersonated_by` text;
--> statement-breakpoint
-- Existing installations retain their accounts, with the oldest account as administrator.
UPDATE `user` SET `role` = 'admin'
WHERE `id` = (SELECT `id` FROM `user` ORDER BY `created_at`, `id` LIMIT 1)
AND NOT EXISTS (SELECT 1 FROM `user` WHERE instr(',' || `role` || ',', ',admin,') > 0);
--> statement-breakpoint
CREATE TABLE `nimbus_app_password` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_app_password_token_hash_unique` ON `nimbus_app_password` (`token_hash`);--> statement-breakpoint
CREATE TABLE `nimbus_bookmark` (
	`user_id` text NOT NULL,
	`path` text NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`accessed_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `path`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `nimbus_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`path` text NOT NULL,
	`permission` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_grant_subject_path` ON `nimbus_grant` (`subject_type`,`subject_id`,`path`);--> statement-breakpoint
CREATE TABLE `nimbus_group_member` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `nimbus_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `nimbus_group` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_group_name_unique` ON `nimbus_group` (`name`);--> statement-breakpoint
CREATE TABLE `nimbus_share` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`path` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`password_hash` text,
	`download_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_share_token_unique` ON `nimbus_share` (`token`);--> statement-breakpoint
CREATE TABLE `nimbus_trash` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`deleted_by` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`deleted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TRIGGER `nimbus_preserve_active_admin_update`
BEFORE UPDATE OF `role`, `banned` ON `user`
WHEN instr(',' || OLD.`role` || ',', ',admin,') > 0 AND OLD.`banned` = 0
AND (instr(',' || NEW.`role` || ',', ',admin,') = 0 OR NEW.`banned` <> 0)
AND NOT EXISTS (
  SELECT 1 FROM `user` WHERE `id` <> OLD.`id`
  AND instr(',' || `role` || ',', ',admin,') > 0 AND `banned` = 0
)
BEGIN
  SELECT RAISE(ABORT, 'Nimbus requires an active administrator');
END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_preserve_active_admin_delete`
BEFORE DELETE ON `user`
WHEN instr(',' || OLD.`role` || ',', ',admin,') > 0 AND OLD.`banned` = 0
AND NOT EXISTS (
  SELECT 1 FROM `user` WHERE `id` <> OLD.`id`
  AND instr(',' || `role` || ',', ',admin,') > 0 AND `banned` = 0
)
BEGIN
  SELECT RAISE(ABORT, 'Nimbus requires an active administrator');
END;
