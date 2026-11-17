-- Changes whose filesystem and database steps a crash could separate (trash, restore, move). Startup finishes or undoes each row left behind.
CREATE TABLE `nimbus_pending_change` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`trash_id` text,
	`from_path` text,
	`to_path` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "nimbus_pending_change_shape" CHECK((kind IN ('trash', 'restore') AND trash_id IS NOT NULL AND from_path IS NULL AND to_path IS NULL) OR (kind = 'move' AND trash_id IS NULL AND from_path IS NOT NULL AND to_path IS NOT NULL))
);
