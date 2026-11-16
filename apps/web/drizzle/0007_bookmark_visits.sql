-- Opens per user and item, so search can rank frequently opened files first. Existing bookmarks count as one open.
ALTER TABLE `nimbus_bookmark` ADD `visits` integer DEFAULT 1 NOT NULL;
