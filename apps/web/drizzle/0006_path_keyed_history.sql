-- Inode-keyed records cannot be mapped to paths without walking the drive. Their payloads become unreferenced and version cleanup removes them a day later.
DELETE FROM `nimbus_file_version`;--> statement-breakpoint
ALTER TABLE `nimbus_file_version` RENAME COLUMN "file_key" TO "path";--> statement-breakpoint
DROP INDEX `nimbus_file_version_file`;--> statement-breakpoint
CREATE INDEX `nimbus_file_version_path` ON `nimbus_file_version` (`path`,`archived_at`);--> statement-breakpoint
CREATE INDEX `nimbus_bookmark_path` ON `nimbus_bookmark` (`path`);--> statement-breakpoint
CREATE INDEX `nimbus_grant_path` ON `nimbus_grant` (`path`);--> statement-breakpoint
CREATE INDEX `nimbus_share_path` ON `nimbus_share` (`path`);--> statement-breakpoint
CREATE INDEX `nimbus_file_request_path` ON `nimbus_file_request` (`path`);