CREATE TABLE `nimbus_dav_property` (
	`path` text NOT NULL,
	`namespace` text NOT NULL,
	`name` text NOT NULL,
	`xml` text NOT NULL,
	PRIMARY KEY(`path`, `namespace`, `name`)
);
--> statement-breakpoint
ALTER TABLE `nimbus_trash` ADD `detached_access` text DEFAULT '{"grants":[],"shares":[],"bookmarks":[],"properties":[]}' NOT NULL;