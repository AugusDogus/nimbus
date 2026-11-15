CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_userId_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentialID_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true NOT NULL,
	`failed_verification_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `two_factor_secret_idx` ON `two_factor` (`secret`);--> statement-breakpoint
CREATE INDEX `two_factor_userId_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE TABLE `nimbus_audit_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`target_type` text,
	`target_id` text,
	`target_label` text,
	`ip` text,
	`user_agent` text,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `nimbus_audit_event_at_idx` ON `nimbus_audit_event` (`at`);--> statement-breakpoint
CREATE INDEX `nimbus_audit_event_action_idx` ON `nimbus_audit_event` (`action`,`id`);--> statement-breakpoint
CREATE INDEX `nimbus_audit_event_actor_idx` ON `nimbus_audit_event` (`actor_id`,`id`);--> statement-breakpoint
ALTER TABLE `user` ADD `two_factor_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Registration is closed, so every existing address was entered by an administrator
-- or the first account owner. Single sign-on links only to verified local addresses.
UPDATE `user` SET `email_verified` = 1;
--> statement-breakpoint
CREATE TRIGGER `nimbus_audit_event_no_update`
BEFORE UPDATE ON `nimbus_audit_event`
BEGIN
  SELECT RAISE(ABORT, 'Nimbus audit events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_audit_event_retain`
BEFORE DELETE ON `nimbus_audit_event`
WHEN OLD.`at` > cast(unixepoch('subsecond') * 1000 as integer) - 2592000000
BEGIN
  SELECT RAISE(ABORT, 'Nimbus keeps audit events for at least 30 days');
END;
--> statement-breakpoint
CREATE TRIGGER `nimbus_audit_event_no_replace`
BEFORE INSERT ON `nimbus_audit_event`
WHEN NEW.`id` IS NOT NULL AND EXISTS (SELECT 1 FROM `nimbus_audit_event` WHERE `id` = NEW.`id`)
BEGIN
  SELECT RAISE(ABORT, 'Nimbus audit events are append-only');
END;
