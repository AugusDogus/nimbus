import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
import { mcpGrants } from "./mcp-schema";

/**
 * A library: folders one account chose to offer, read-only, to the devices it pairs. A paired
 * device is bound to exactly one library and reaches nothing outside its folders, whatever its
 * owner may read.
 */
export const libraries = sqliteTable(
  "nimbus_library",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: integer("created_at").notNull(),
    /** When the title or folders last changed. */
    updatedAt: integer("updated_at").notNull(),
    /** When the catalog last gained, lost or changed an item. */
    catalogChangedAt: integer("catalog_changed_at").notNull(),
  },
  (table) => [index("nimbus_library_owner").on(table.ownerId)],
);

/**
 * A folder of a library, by drive path, in the order its owner arranged them. A folder that is
 * missing contributes nothing and contributes again once the path exists; it is never followed
 * to a new location.
 */
export const libraryFolders = sqliteTable(
  "nimbus_library_folder",
  {
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** 0 for the first folder. */
    position: integer("position").notNull(),
    addedAt: integer("added_at").notNull(),
    /**
     * When the catalog first scanned the folder while it existed. Files found by that scan are
     * dated by their modification time; files found later, by when the catalog first saw them.
     */
    scannedAt: integer("scanned_at"),
  },
  (table) => [
    primaryKey({ columns: [table.libraryId, table.path] }),
    uniqueIndex("nimbus_library_folder_position").on(
      table.libraryId,
      table.position,
    ),
    check("nimbus_library_folder_not_root", sql`${table.path} <> ''`),
  ],
);

export const LIBRARY_ITEM_KINDS = [
  "video",
  "audio",
  "image",
  "document",
  "other",
] as const;
export type LibraryItemKind = (typeof LIBRARY_ITEM_KINDS)[number];

/**
 * What a library's catalog has seen: one row per file, with an opaque random id and the date it
 * joined the library. A file that disappears becomes a tombstone (`missingSince`), never listed
 * or reachable, so that the same file coming back to the same path keeps its row; see
 * CatalogIdentity. Nimbus's own renames and moves carry rows along.
 */
export const libraryItems = sqliteTable(
  "nimbus_library_item",
  {
    id: text("id").primaryKey(),
    libraryId: text("library_id")
      .notNull()
      .references(() => libraries.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    addedAt: integer("added_at").notNull(),
    version: text("version").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Whole milliseconds. */
    modifiedAt: integer("modified_at").notNull(),
    missingSince: integer("missing_since"),
  },
  (table) => [
    uniqueIndex("nimbus_library_item_library_path")
      .on(table.libraryId, table.path)
      .where(sql`${table.missingSince} IS NULL`),
    index("nimbus_library_item_missing").on(
      table.libraryId,
      table.missingSince,
    ),
    // Renames, moves and trash rewrite records under a path prefix.
    index("nimbus_library_item_path").on(table.path),
  ],
);

export const DEVICE_PAIRING_STATES = [
  "pending",
  "approved",
  "denied",
  "redeemed",
] as const;
export type DevicePairingState = (typeof DEVICE_PAIRING_STATES)[number];

/**
 * A device asking to pair: its device code and pairing code, stored only as SHA-256 hashes, and
 * the owner's decision. Approval records the account and library; the device's token is minted
 * when it next polls, so no usable credential is ever stored.
 */
export const devicePairings = sqliteTable(
  "nimbus_device_pairing",
  {
    id: text("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    pairingCodeHash: text("pairing_code_hash").notNull().unique(),
    deviceName: text("device_name").notNull(),
    state: text("state", { enum: DEVICE_PAIRING_STATES }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    /** The least time between polls, in seconds; each early poll adds five. */
    intervalSeconds: integer("interval_seconds").notNull(),
    lastPolledAt: integer("last_polled_at"),
    ownerId: text("owner_id").references(() => user.id, {
      onDelete: "cascade",
    }),
    libraryId: text("library_id").references(() => libraries.id, {
      onDelete: "cascade",
    }),
    decidedAt: integer("decided_at"),
  },
  (table) => [
    index("nimbus_device_pairing_expiry").on(table.expiresAt),
    check(
      "nimbus_device_pairing_decision",
      sql`(${table.state} IN ('approved', 'redeemed')) = (${table.ownerId} IS NOT NULL AND ${table.libraryId} IS NOT NULL)`,
    ),
  ],
);

export const DEVICE_REVOCATION_REASONS = [
  "settings",
  "idle_lapsed",
  "library_deleted",
  "password_changed",
  "password_reset",
  "password_set",
  "signed_out_everywhere",
  "sign_in_methods_reset",
  "account_disabled",
] as const;
export type DeviceRevocationReason = (typeof DEVICE_REVOCATION_REASONS)[number];

/**
 * A paired device: a grant of the `device` resource in the OAuth grant store, bound to one
 * library. Its token is a `device_token` row of that grant. Revoking the grant ends the device;
 * revoked devices stay so their token is told it was revoked.
 */
export const pairedDevices = sqliteTable(
  "nimbus_paired_device",
  {
    grantId: text("grant_id")
      .primaryKey()
      .references(() => mcpGrants.id, { onDelete: "cascade" }),
    libraryId: text("library_id").references(() => libraries.id, {
      onDelete: "set null",
    }),
    deviceName: text("device_name").notNull(),
    /** Why the grant was revoked, when a device action revoked it. */
    revokedReason: text("revoked_reason", { enum: DEVICE_REVOCATION_REASONS }),
    /**
     * Media addresses minted for the device so far. Each address carries its number, and only
     * the newest `MAX_TICKETS_PER_DEVICE` are accepted (see MediaTickets).
     */
    mediaTicketsMinted: integer("media_tickets_minted").notNull().default(0),
  },
  (table) => [index("nimbus_paired_device_library").on(table.libraryId)],
);

export const LIBRARY_POSTER_STATES = ["ready", "failed", "timed_out"] as const;
export type LibraryPosterState = (typeof LIBRARY_POSTER_STATES)[number];

/**
 * What drawing an item's poster found, for one version of its file: the source's dimensions
 * once a poster was drawn, so the listing can give them without decoding anything, or that the
 * file could not be drawn (or ran out of time), so it is not tried on every request. A row for
 * another version says nothing about the current one.
 */
export const libraryPosters = sqliteTable(
  "nimbus_library_poster",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => libraryItems.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    state: text("state", { enum: LIBRARY_POSTER_STATES }).notNull(),
    width: integer("width"),
    height: integer("height"),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    check(
      "nimbus_library_poster_dimensions",
      sql`(${table.state} = 'ready') = (${table.width} IS NOT NULL AND ${table.height} IS NOT NULL AND ${table.width} > 0 AND ${table.height} > 0)`,
    ),
  ],
);
