-- What drawing a library item's poster found for one version of its file: the source's dimensions, or that it could not be drawn.
CREATE TABLE `nimbus_library_poster` (
	`item_id` text PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`state` text NOT NULL,
	`width` integer,
	`height` integer,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `nimbus_library_item`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "nimbus_library_poster_dimensions" CHECK(("nimbus_library_poster"."state" = 'ready') = ("nimbus_library_poster"."width" IS NOT NULL AND "nimbus_library_poster"."height" IS NOT NULL AND "nimbus_library_poster"."width" > 0 AND "nimbus_library_poster"."height" > 0))
);
