-- Inode-keyed records cannot be mapped to paths without walking the drive. Their payloads become unreferenced and version cleanup removes them a day later.
DELETE FROM `nimbus_file_version`;--> statement-breakpoint
ALTER TABLE `nimbus_file_version` RENAME COLUMN "file_key" TO "path";--> statement-breakpoint
DROP INDEX `nimbus_file_version_file`;--> statement-breakpoint
CREATE INDEX `nimbus_file_version_path` ON `nimbus_file_version` (`path`,`archived_at`);--> statement-breakpoint
CREATE INDEX `nimbus_bookmark_path` ON `nimbus_bookmark` (`path`);--> statement-breakpoint
CREATE INDEX `nimbus_grant_path` ON `nimbus_grant` (`path`);--> statement-breakpoint
CREATE INDEX `nimbus_share_path` ON `nimbus_share` (`path`);--> statement-breakpoint
CREATE INDEX `nimbus_file_request_path` ON `nimbus_file_request` (`path`);--> statement-breakpoint
-- One counter that changes whenever anything a permission check reads changes, whoever writes it: the drive store, Better Auth, or single sign-on group sync. Cached access is reused only while it is unchanged.
CREATE TABLE `nimbus_access_epoch` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 0),
	`value` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `nimbus_access_epoch` (`id`, `value`) VALUES (0, 0);
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_grant_insert` AFTER INSERT ON `nimbus_grant` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_grant_update` AFTER UPDATE ON `nimbus_grant` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_grant_delete` AFTER DELETE ON `nimbus_grant` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_member_insert` AFTER INSERT ON `nimbus_group_member` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_member_update` AFTER UPDATE ON `nimbus_group_member` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_member_delete` AFTER DELETE ON `nimbus_group_member` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_group_delete` AFTER DELETE ON `nimbus_group` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_user_update` AFTER UPDATE ON `user` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_access_epoch_user_delete` AFTER DELETE ON `user` BEGIN UPDATE `nimbus_access_epoch` SET `value` = `value` + 1; END;
