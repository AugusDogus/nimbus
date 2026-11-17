import { z } from "zod";
import type { FileRequestStore } from "./file-request";
import type { FileVersionStore } from "./file-versions";

export const permissionSchema = z.enum(["read", "write", "admin"]);
export type Permission = z.infer<typeof permissionSchema>;
export const subjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: z.string().min(1) }),
  z.object({ type: z.literal("group"), id: z.string().min(1) }),
]);
export type Subject = z.infer<typeof subjectSchema>;
export type DriveUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  banned: boolean;
};
export type Grant = {
  id: string;
  subject: Subject;
  path: string;
  permission: Permission;
};
/** `view` links offer previews only; `download` links also offer downloads and ZIPs. */
export const shareModeSchema = z.enum(["download", "view"]);
export type ShareMode = z.infer<typeof shareModeSchema>;
export type Group = { id: string; name: string; memberIds: string[] };
export type Share = {
  id: string;
  token: string;
  path: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  passwordHash: string | null;
  downloadCount: number;
  maxDownloads: number | null;
  mode: ShareMode;
};
export type ShareSettings = Pick<
  Share,
  "expiresAt" | "passwordHash" | "maxDownloads" | "mode"
>;
export type TrashItem = {
  id: string;
  path: string;
  deletedBy: string;
  deletedAt: number;
  expiresAt: number;
};
export type Bookmark = {
  path: string;
  starred: boolean;
  accessedAt: number;
  /** How many times this user opened the item. */
  visits: number;
};
export type BookmarkChange =
  | { type: "open" }
  | { type: "star"; starred: boolean };
/** A WebDAV dead property: an arbitrary client-set XML element, keyed by expanded name. */
export type DavProperty = { namespace: string; name: string; xml: string };
export type DavPropertyName = Pick<DavProperty, "namespace" | "name">;
export type AppPassword = {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: number;
};

/** An account's personal folder, kept at a fixed path for the account's lifetime. */
export type Home = { userId: string; path: string };
/** Live paths that carry each kind of sharing record; records detached into trash are not live. */
export type SharedPaths = {
  grants: string[];
  links: string[];
  fileRequests: string[];
  bookmarks: string[];
};

/** Persistence boundary. Filesystem content remains on disk, never in these records. */
export type DriveStore = {
  /**
   * A number that changes whenever any account, grant, group or membership changes, by
   * whatever writer. Access computed at one epoch stays valid until it changes.
   */
  accessEpoch(): Promise<number>;
  getUser(id: string): Promise<DriveUser | null>;
  listUsers(): Promise<DriveUser[]>;
  grantsForUser(userId: string): Promise<Grant[]>;
  grantsForPath(path: string): Promise<Grant[]>;
  saveGrant(grant: Grant): Promise<void>;
  removeGrant(id: string): Promise<void>;
  listGroups(): Promise<Group[]>;
  saveGroup(group: Group): Promise<void>;
  removeGroup(id: string): Promise<void>;
  createShare(share: Share): Promise<void>;
  getShare(token: string): Promise<Share | null>;
  listShares(userId: string): Promise<Share[]>;
  updateShare(
    id: string,
    userId: string,
    settings: ShareSettings,
  ): Promise<Share | null>;
  revokeShare(id: string, userId: string): Promise<void>;
  /** Atomically count one download unless the link has used its limit. */
  claimDownload(id: string): Promise<boolean>;
  homeOf(userId: string): Promise<string | null>;
  listHomes(): Promise<Home[]>;
  /** Whether a home folder is at or under a path. */
  hasHomeWithin(path: string): Promise<boolean>;
  /** Record a home and its owner's grant together. Fails if the account already has a home. */
  createHome(home: Home, grant: Grant): Promise<void>;
  /** Folders Nimbus created to hold home folders. */
  listHomeContainers(): Promise<string[]>;
  /** Record that Nimbus is creating `path` to hold home folders. */
  addHomeContainer(path: string): Promise<void>;
  /** Forget a home container record whose folder could not be created. */
  removeHomeContainer(path: string): Promise<void>;
  /** Every live path with a grant, public link, upload link, or bookmark, by kind. */
  sharedPaths(): Promise<SharedPaths>;
  /** Dead properties of each path. Paths without properties are absent from the map. */
  davProperties(paths: readonly string[]): Promise<Map<string, DavProperty[]>>;
  /** Set and remove dead properties of one path in a single transaction. */
  patchDavProperties(
    path: string,
    set: readonly DavProperty[],
    remove: readonly DavPropertyName[],
  ): Promise<void>;
  /** Replace the dead properties at or under `to` with copies of those at or under `from`. */
  copyDavProperties(from: string, to: string): Promise<void>;
  /**
   * Record a trashed item and, in the same transaction, detach the public links, direct
   * grants, bookmarks, and dead properties at or under its path. Detached records stay with the trash record
   * and never match live paths, so content later created at that path cannot inherit them.
   */
  addTrash(item: TrashItem): Promise<void>;
  getTrash(id: string): Promise<TrashItem | null>;
  /**
   * The grants detached with a trash item that apply to an account, directly or through a
   * group it belongs to now. Empty when the item is not in trash.
   */
  detachedGrantsFor(id: string, userId: string): Promise<Grant[]>;
  listTrash(userId: string | null): Promise<TrashItem[]>;
  /** Delete a trash record and reattach its detached records at the item's original path. */
  restoreTrash(id: string): Promise<void>;
  /** Permanently delete a trash record together with its detached records. */
  removeTrash(id: string): Promise<void>;
  listBookmarks(userId: string): Promise<Bookmark[]>;
  saveBookmark(userId: string, bookmark: Bookmark): Promise<void>;
  /**
   * Record, in one statement, an open of `path` (one more visit, opened at
   * `at`) or a change of its star (which is not an open), creating the
   * bookmark if needed.
   */
  recordBookmark(
    userId: string,
    path: string,
    change: BookmarkChange,
    at: number,
  ): Promise<void>;
  listAppPasswords(userId: string): Promise<AppPassword[]>;
  addAppPassword(password: AppPassword): Promise<void>;
  findAppPassword(tokenHash: string): Promise<AppPassword | null>;
  removeAppPassword(id: string, userId: string): Promise<void>;
  /**
   * Rewrite links, direct grants, bookmarks, and dead properties at or under `from` to the same relative
   * location under `to`, after dropping records left at or under the vacant `to` by content
   * removed outside Nimbus. Grants on ancestors are never rewritten: moved content loses what
   * it inherited at its source and inherits from its destination instead.
   */
  movePath(from: string, to: string): Promise<void>;
  /**
   * Delete the links, direct grants, file requests, bookmarks, dead properties and file history
   * at or under a path where nothing exists, in one transaction. Only content removed outside
   * Nimbus leaves records at a vacant path; Nimbus's own moves and trash take theirs along, and
   * a file moved over another ends its records here once its content has moved. Call it through
   * `VacantPath.claim`, which checks the path is vacant, unless the caller just emptied the path
   * itself. Payloads of dropped history are swept by version cleanup.
   */
  claimVacant(path: string): Promise<void>;
  fileRequests: FileRequestStore;
  versions: FileVersionStore;
};
