-- Changes whose filesystem and database steps a crash could separate (trash, restore, move); startup finishes or undoes each row left behind, recognising the item by its device and inode. Case-insensitive path indexes find records under any spelling of a path Nimbus creates.
CREATE TABLE `nimbus_pending_change` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`trash_id` text,
	`from_path` text,
	`to_path` text,
	`identity` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "nimbus_pending_change_shape" CHECK((kind IN ('trash', 'restore') AND trash_id IS NOT NULL AND from_path IS NULL AND to_path IS NULL) OR (kind = 'move' AND trash_id IS NULL AND from_path IS NOT NULL AND to_path IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `nimbus_grant_path_nocase` ON `nimbus_grant` ("path" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `nimbus_share_path_nocase` ON `nimbus_share` ("path" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `nimbus_file_request_path_nocase` ON `nimbus_file_request` ("path" COLLATE NOCASE);