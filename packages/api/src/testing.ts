import type { AppPassword, Bookmark, DavProperty, DriveStore, DriveUser, Grant, Group, Home, Share, TrashItem } from "./drive-store";
import { isWithinPath } from "./safe-path";
import { createTestFileRequestStore } from "./file-request-testing";

export function createTestDriveStore() {
  const users = new Map<string, DriveUser>([["user-1", { id: "user-1", name: "Owner", email: "owner@example.test", role: "admin", banned: false }], ["reader", { id: "reader", name: "Reader", email: "reader@example.test", role: "user", banned: false }]]);
  const grants = new Map<string, Grant>();
  const groups = new Map<string, Group>();
  const shares = new Map<string, Share>();
  const trash = new Map<string, TrashItem>();
  const properties = new Map<string, DavProperty[]>();
  const homes = new Map<string, Home>();
  type Detached = { grants: Grant[]; shares: Share[]; bookmarks: [string, Bookmark][]; properties: [string, DavProperty[]][] };
  const detached = new Map<string, Detached>();
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
    async updateShare(id, userId, settings) { for (const [token, share] of shares) if (share.id === id && share.createdBy === userId) { const updated = { ...share, ...settings }; shares.set(token, updated); return updated; } return null; },
    async claimDownload(id) { for (const share of shares.values()) if (share.id === id && (share.maxDownloads === null || share.downloadCount < share.maxDownloads)) { share.downloadCount++; return true; } return false; },
    async addTrash(item) { trash.set(item.id, item); detached.set(item.id, take(item.path)); },
    async getTrash(id) { return trash.get(id) ?? null; },
    async listTrash(userId) { return [...trash.values()].filter((item) => userId === null || item.deletedBy === userId); },
    async restoreTrash(id) {
      const item = trash.get(id);
      const records = detached.get(id);
      trash.delete(id); detached.delete(id);
      if (!item || !records) return;
      take(item.path);
      for (const grant of records.grants) grants.set(grant.id, grant);
      for (const share of records.shares) shares.set(share.token, share);
      for (const [userId, bookmark] of records.bookmarks) bookmarks.set(userId, [...(bookmarks.get(userId) ?? []), bookmark]);
      for (const [path, entries] of records.properties) properties.set(path, entries);
    },
    async homeOf(userId) { return homes.get(userId)?.path ?? null; },
    async listHomes() { return [...homes.values()]; },
    async hasHomeWithin(path) { return [...homes.values()].some((home) => isWithinPath(path, home.path)); },
    async createHome(home, grant) {
      if (homes.has(home.userId) || [...homes.values()].some((other) => other.path === home.path)) throw new Error(`A home already exists for ${home.userId} or at ${home.path}.`);
      homes.set(home.userId, home); grants.set(grant.id, grant);
    },
    async davProperties(paths) { return new Map(paths.flatMap((path) => { const entries = properties.get(path); return entries?.length ? [[path, entries] as const] : []; })); },
    async patchDavProperties(path, set, remove) {
      const kept = (properties.get(path) ?? []).filter((entry) => ![...set, ...remove].some((other) => other.namespace === entry.namespace && other.name === entry.name));
      properties.set(path, [...kept, ...set]);
    },
    async copyDavProperties(from, to) {
      for (const path of properties.keys()) if (isWithinPath(to, path)) properties.delete(path);
      for (const [path, entries] of [...properties]) if (isWithinPath(from, path)) properties.set(to + path.slice(from.length), [...entries]);
    },
    async removeTrash(id) { trash.delete(id); detached.delete(id); },
    async listBookmarks(userId) { return bookmarks.get(userId) ?? []; },
    async saveBookmark(userId, bookmark) { bookmarks.set(userId, [...(bookmarks.get(userId) ?? []).filter((entry) => entry.path !== bookmark.path), bookmark]); },
    async listAppPasswords(userId) { return [...passwords.values()].filter((password) => password.userId === userId); },
    async addAppPassword(password) { passwords.set(password.id, password); },
    async findAppPassword(hash) { return [...passwords.values()].find((password) => password.tokenHash === hash) ?? null; },
    async removeAppPassword(id, userId) { if (passwords.get(id)?.userId === userId) passwords.delete(id); },
    fileRequests: createTestFileRequestStore(),
    async discardPath(path) { take(path); },
    async movePath(from, to) {
      take(to);
      const moved = (value: string) => isWithinPath(from, value) ? to + value.slice(from.length) : value;
      for (const grant of grants.values()) grant.path = moved(grant.path);
      for (const share of shares.values()) share.path = moved(share.path);
      for (const entries of bookmarks.values()) for (const entry of entries) entry.path = moved(entry.path);
      for (const [path, entries] of [...properties]) if (isWithinPath(from, path)) { properties.delete(path); properties.set(moved(path), entries); }
    },
  };
  /** Remove and return every record at or under a path. */
  function take(path: string) {
    const taken: Detached = { grants: [], shares: [], bookmarks: [], properties: [] };
    for (const [id, grant] of grants) if (isWithinPath(path, grant.path)) { taken.grants.push(grant); grants.delete(id); }
    for (const [token, share] of shares) if (isWithinPath(path, share.path)) { taken.shares.push(share); shares.delete(token); }
    for (const [userId, entries] of bookmarks) {
      for (const entry of entries) if (isWithinPath(path, entry.path)) taken.bookmarks.push([userId, entry]);
      bookmarks.set(userId, entries.filter((entry) => !isWithinPath(path, entry.path)));
    }
    for (const [propertyPath, entries] of [...properties]) if (isWithinPath(path, propertyPath)) { taken.properties.push([propertyPath, entries]); properties.delete(propertyPath); }
    return taken;
  }
  return { store, users, grants, groups, shares, trash, properties, homes };
}
