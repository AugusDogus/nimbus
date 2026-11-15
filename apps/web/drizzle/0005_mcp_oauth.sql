CREATE TABLE `nimbus_mcp_client` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris_json` text NOT NULL,
	`token_endpoint_auth_method` text NOT NULL,
	`client_secret_hash` text,
	`scope` text NOT NULL,
	`client_uri` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nimbus_mcp_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `nimbus_mcp_client`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nimbus_mcp_grant_user` ON `nimbus_mcp_grant` (`user_id`);--> statement-breakpoint
CREATE TABLE `nimbus_mcp_token` (
	`hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`grant_id` text NOT NULL,
	`scope` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`redirect_uri` text,
	`code_challenge` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `nimbus_mcp_grant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nimbus_mcp_token_grant` ON `nimbus_mcp_token` (`grant_id`);--> statement-breakpoint
CREATE INDEX `nimbus_mcp_token_expiry` ON `nimbus_mcp_token` (`expires_at`);