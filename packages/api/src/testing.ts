import type { AppPassword, Bookmark, DriveStore, DriveUser, Grant, Group, Share, TrashItem } from "./drive-store";
import { isWithinPath } from "./safe-path";

export function createTestDriveStore() {
  const users = new Map<string, DriveUser>([["user-1", { id: "user-1", name: "Owner", email: "owner@example.test", role: "admin", banned: false }], ["reader", { id: "reader", name: "Reader", email: "reader@example.test", role: "user", banned: false }]]);
  const grants = new Map<string, Grant>();
  const groups = new Map<string, Group>();
  const shares = new Map<string, Share>();
  const trash = new Map<string, TrashItem>();
  const bookmarks = new Map<string, Bookmark[]>();
  const passwords = new Map<string, AppPassword>();
  const store: DriveStore = {
    async getUser(id) { return users.get(id) ?? null; },
    async listUsers() { return [...users.values()]; },
    async grantsForUser(id) { return [...grants.values()].filter((grant) => grant.subject.type === "user" ? grant.subject.id === id : groups.get(grant.subject.id)?.memberIds.includes(id)); },
    async grantsForPath(path) { return [...grants.values()].filter((grant) => grant.path === path); },
    async saveGrant(grant) { grants.set(grant.id, grant); },
    async removeGrant(id) { grants.delete(id); },
    async listGroups() { return [...groups.values()]; },
    async saveGroup(group) { groups.set(group.id, group); },
    async removeGroup(id) { groups.delete(id); for (const [key, grant] of grants) if (grant.subject.type === "group" && grant.subject.id === id) grants.delete(key); },
    async createShare(share) { shares.set(share.token, share); },
    async getShare(token) { return shares.get(token) ?? null; },
    async listShares(userId) { return [...shares.values()].filter((share) => share.createdBy === userId); },
    async revokeShare(id, userId) { for (const [token, share] of shares) if (share.id === id && share.createdBy === userId) shares.delete(token); },
    async countDownload(id) { for (const share of shares.values()) if (share.id === id) share.downloadCount++; },
    async addTrash(item) { trash.set(item.id, item); },
    async getTrash(id) { return trash.get(id) ?? null; },
    async listTrash(userId) { return [...trash.values()].filter((item) => userId === null || item.deletedBy === userId); },
    async removeTrash(id) { trash.delete(id); },
    async listBookmarks(userId) { return bookmarks.get(userId) ?? []; },
    async saveBookmark(userId, bookmark) { bookmarks.set(userId, [...(bookmarks.get(userId) ?? []).filter((entry) => entry.path !== bookmark.path), bookmark]); },
    async listAppPasswords(userId) { return [...passwords.values()].filter((password) => password.userId === userId); },
    async addAppPassword(password) { passwords.set(password.id, password); },
    async findAppPassword(hash) { return [...passwords.values()].find((password) => password.tokenHash === hash) ?? null; },
    async removeAppPassword(id, userId) { if (passwords.get(id)?.userId === userId) passwords.delete(id); },
    async forgetPath(path) {
      for (const [id, grant] of grants) if (isWithinPath(path, grant.path)) grants.delete(id);
      for (const [token, share] of shares) if (isWithinPath(path, share.path)) shares.delete(token);
      for (const [userId, entries] of bookmarks) bookmarks.set(userId, entries.filter((entry) => !isWithinPath(path, entry.path)));
    },
  };
  return { store, users, grants, groups, shares, trash };
}
