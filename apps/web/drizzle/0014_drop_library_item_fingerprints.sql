-- Library catalogs no longer keep content fingerprints or first-seen times: identity across moves made outside Nimbus is left for a later version. Tombstones and same-path returns stay.
ALTER TABLE `nimbus_library_item` DROP COLUMN `first_seen_at`;--> statement-breakpoint
ALTER TABLE `nimbus_library_item` DROP COLUMN `fingerprint`;