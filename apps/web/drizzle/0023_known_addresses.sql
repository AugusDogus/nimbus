CREATE TABLE `nimbus_known_address` (
	`account` text NOT NULL,
	`address` text NOT NULL,
	`used` integer NOT NULL,
	PRIMARY KEY(`account`, `address`)
);
