import { z } from "zod";

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
};
export type TrashItem = {
  id: string;
  path: string;
  deletedBy: string;
  deletedAt: number;
  expiresAt: number;
};
export type Bookmark = { path: string; starred: boolean; accessedAt: number };
export type AppPassword = {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: number;
};

/** Persistence boundary. Filesystem content remains on disk, never in these records. */
export type DriveStore = {
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
  revokeShare(id: string, userId: string): Promise<void>;
  countDownload(id: string): Promise<void>;
  /**
   * Record a trashed item and, in the same transaction, detach the public links, direct
   * grants, and bookmarks at or under its path. Detached records stay with the trash record
   * and never match live paths, so content later created at that path cannot inherit them.
   */
  addTrash(item: TrashItem): Promise<void>;
  getTrash(id: string): Promise<TrashItem | null>;
  listTrash(userId: string | null): Promise<TrashItem[]>;
  /** Delete a trash record and reattach its detached records at the item's original path. */
  restoreTrash(id: string): Promise<void>;
  /** Permanently delete a trash record together with its detached records. */
  removeTrash(id: string): Promise<void>;
  listBookmarks(userId: string): Promise<Bookmark[]>;
  saveBookmark(userId: string, bookmark: Bookmark): Promise<void>;
  listAppPasswords(userId: string): Promise<AppPassword[]>;
  addAppPassword(password: AppPassword): Promise<void>;
  findAppPassword(tokenHash: string): Promise<AppPassword | null>;
  removeAppPassword(id: string, userId: string): Promise<void>;
  /**
   * Rewrite links, direct grants, and bookmarks at or under `from` to the same relative
   * location under `to`, after dropping records left at or under the vacant `to` by content
   * removed outside Nimbus. Grants on ancestors are never rewritten: moved content loses what
   * it inherited at its source and inherits from its destination instead.
   */
  movePath(from: string, to: string): Promise<void>;
};
