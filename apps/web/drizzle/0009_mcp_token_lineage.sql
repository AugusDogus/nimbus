ALTER TABLE `nimbus_mcp_token` ADD `parent_hash` text;--> statement-breakpoint
ALTER TABLE `nimbus_mcp_token` ADD `used_at` integer;--> statement-breakpoint
CREATE INDEX `nimbus_mcp_token_parent` ON `nimbus_mcp_token` (`parent_hash`);