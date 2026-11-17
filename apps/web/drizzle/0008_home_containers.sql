-- Folders Nimbus created to hold home folders. Home folders go only into a folder recorded here, never into one that existed before and may already be shared.
CREATE TABLE `nimbus_home_container` (
	`path` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
