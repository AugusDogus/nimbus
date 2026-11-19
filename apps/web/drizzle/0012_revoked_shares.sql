-- Links their owner turned off, by the SHA-256 of their token, so a visitor opening one is told the link was turned off rather than that it never existed.
CREATE TABLE `nimbus_revoked_share` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`revoked_at` integer NOT NULL
);
