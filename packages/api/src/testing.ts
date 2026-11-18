import type {
  AppPassword,
  Bookmark,
  DavProperty,
  DriveStore,
  DriveUser,
  Grant,
  Group,
  Home,
  PendingChange,
  Share,
  TrashItem,
} from "./drive-store";
import { isWithinPath } from "./safe-path";
import { createTestFileRequestStore } from "./file-request-testing";
import { createTestFileVersionStore } from "./file-versions-testing";
import { FileVersions } from "./file-versions";
import { crawl, reconcile } from "./search-crawler";
import { createSearchIndex, type SearchIndex } from "./search-index";
import type { SearchService } from "./search-service";

export function createTestDriveStore() {
  const users = new Map<string, DriveUser>([
    [
      "user-1",
      {
        id: "user-1",
        name: "Owner",
        email: "owner@example.test",
        role: "admin",
        banned: false,
      },
    ],
    [
      "reader",
      {
        id: "reader",
        name: "Reader",
        email: "reader@example.test",
        role: "user",
        banned: false,
      },
    ],
  ]);
  const grants = new Map<string, Grant>();
  const groups = new Map<string, Group>();
  const shares = new Map<string, Share>();
  const trash = new Map<string, TrashItem>();
  const properties = new Map<string, DavProperty[]>();
  const homes = new Map<string, Home>();
  const homeContainers = new Set<string>();
  const settings = { allowHomeContainerSharing: false };
  const fileRequests = createTestFileRequestStore();
  type Detached = {
    grants: Grant[];
    shares: Share[];
    bookmarks: [string, Bookmark][];
    properties: [string, DavProperty[]][];
  };
  const detached = new Map<string, Detached>();
  const bookmarks = new Map<string, Bookmark[]>();
  const passwords = new Map<string, AppPassword>();
  const pending = new Map<string, PendingChange>();
  const versions = createTestFileVersionStore();
  // Tests edit the maps directly, so cached access is never reused.
  let epoch = 0;
  const store: DriveStore = {
    async accessEpoch() {
      return ++epoch;
    },
    async getUser(id) {
      return users.get(id) ?? null;
    },
    async listUsers() {
      return [...users.values()];
    },
    async grantsForUser(id) {
      return [...grants.values()].filter((grant) =>
        grant.subject.type === "user"
          ? grant.subject.id === id
          : groups.get(grant.subject.id)?.memberIds.includes(id),
      );
    },
    async grantsForPath(path) {
      return [...grants.values()].filter((grant) => grant.path === path);
    },
    async saveGrant(grant) {
      grants.set(grant.id, grant);
    },
    async removeGrant(id) {
      grants.delete(id);
    },
    async listGroups() {
      return [...groups.values()];
    },
    async saveGroup(group) {
      groups.set(group.id, group);
    },
    async removeGroup(id) {
      groups.delete(id);
      for (const [key, grant] of grants)
        if (grant.subject.type === "group" && grant.subject.id === id)
          grants.delete(key);
    },
    async createShare(share) {
      shares.set(share.token, share);
    },
    async getShare(token) {
      return shares.get(token) ?? null;
    },
    async listShares(userId) {
      return [...shares.values()].filter((share) => share.createdBy === userId);
    },
    async revokeShare(id, userId) {
      for (const [token, share] of shares)
        if (share.id === id && share.createdBy === userId) shares.delete(token);
    },
    async updateShare(id, userId, settings) {
      for (const [token, share] of shares)
        if (share.id === id && share.createdBy === userId) {
          const updated = { ...share, ...settings };
          shares.set(token, updated);
          return updated;
        }
      return null;
    },
    async claimDownload(id) {
      for (const share of shares.values())
        if (
          share.id === id &&
          (share.maxDownloads === null ||
            share.downloadCount < share.maxDownloads)
        ) {
          share.downloadCount++;
          return true;
        }
      return false;
    },
    async addTrash(item) {
      trash.set(item.id, item);
      detached.set(item.id, take(item.path));
      versions.relocate(item.path, FileVersions.trashLocation(item.id));
    },
    async getTrash(id) {
      return trash.get(id) ?? null;
    },
    async detachedGrantsFor(id, userId) {
      return (detached.get(id)?.grants ?? []).filter((grant) =>
        grant.subject.type === "user"
          ? grant.subject.id === userId
          : groups.get(grant.subject.id)?.memberIds.includes(userId),
      );
    },
    async listTrash(userId) {
      return [...trash.values()].filter(
        (item) => userId === null || item.deletedBy === userId,
      );
    },
    async restoreTrash(id) {
      const item = trash.get(id);
      const records = detached.get(id);
      trash.delete(id);
      detached.delete(id);
      if (!item || !records) return;
      take(item.path);
      versions.relocate(FileVersions.trashLocation(item.id), item.path);
      for (const grant of records.grants) grants.set(grant.id, grant);
      for (const share of records.shares) shares.set(share.token, share);
      for (const [userId, bookmark] of records.bookmarks)
        bookmarks.set(userId, [...(bookmarks.get(userId) ?? []), bookmark]);
      for (const [path, entries] of records.properties)
        properties.set(path, entries);
    },
    async homeOf(userId) {
      return homes.get(userId)?.path ?? null;
    },
    async listHomes() {
      return [...homes.values()];
    },
    async hasHomeWithin(path) {
      return [...homes.values()].some((home) => isWithinPath(path, home.path));
    },
    async createHome(home, grant) {
      if (
        homes.has(home.userId) ||
        [...homes.values()].some((other) => other.path === home.path)
      )
        throw new Error(
          `A home already exists for ${home.userId} or at ${home.path}.`,
        );
      homes.set(home.userId, home);
      grants.set(grant.id, grant);
    },
    async listHomeContainers() {
      return [...homeContainers];
    },
    async addHomeContainer(path) {
      if (homeContainers.has(path))
        throw new Error(`A home container is already recorded at ${path}.`);
      homeContainers.add(path);
    },
    async removeHomeContainer(path) {
      homeContainers.delete(path);
    },
    async sharingAt(paths) {
      const at = new Set(paths);
      const requests = (
        await Promise.all(
          [...users.keys()].map((userId) => fileRequests.list(userId)),
        )
      ).flat();
      return {
        grants: [...grants.values()].filter((grant) => at.has(grant.path)),
        links: [...shares.values()].filter((share) => at.has(share.path)),
        fileRequests: (
          await Promise.all(
            requests
              .filter((request) => at.has(request.path))
              .map((request) => fileRequests.getById(request.id)),
          )
        ).filter((request) => request !== null),
      };
    },
    async homeContainerSharingAllowed() {
      return settings.allowHomeContainerSharing;
    },
    async setHomeContainerSharingAllowed(allowed) {
      const previous = settings.allowHomeContainerSharing;
      settings.allowHomeContainerSharing = allowed;
      return previous;
    },
    async sharedPaths() {
      const requests = (
        await Promise.all(
          [...users.keys()].map((userId) => fileRequests.list(userId)),
        )
      ).flat();
      return {
        grants: [...grants.values()].map((grant) => grant.path),
        links: [...shares.values()].map((share) => share.path),
        fileRequests: requests.map((request) => request.path),
        bookmarks: [...bookmarks.values()]
          .flat()
          .map((bookmark) => bookmark.path),
      };
    },
    async davProperties(paths) {
      return new Map(
        paths.flatMap((path) => {
          const entries = properties.get(path);
          return entries?.length ? [[path, entries] as const] : [];
        }),
      );
    },
    async patchDavProperties(path, set, remove) {
      const kept = (properties.get(path) ?? []).filter(
        (entry) =>
          ![...set, ...remove].some(
            (other) =>
              other.namespace === entry.namespace && other.name === entry.name,
          ),
      );
      properties.set(path, [...kept, ...set]);
    },
    async copyDavProperties(from, to) {
      for (const path of properties.keys())
        if (isWithinPath(to, path)) properties.delete(path);
      for (const [path, entries] of [...properties])
        if (isWithinPath(from, path))
          properties.set(to + path.slice(from.length), [...entries]);
    },
    async removeTrash(id) {
      trash.delete(id);
      detached.delete(id);
    },
    async listBookmarks(userId) {
      return bookmarks.get(userId) ?? [];
    },
    async saveBookmark(userId, bookmark) {
      bookmarks.set(userId, [
        ...(bookmarks.get(userId) ?? []).filter(
          (entry) => entry.path !== bookmark.path,
        ),
        bookmark,
      ]);
    },
    async recordBookmark(userId, path, change, at) {
      const list = bookmarks.get(userId) ?? [];
      const existing = list.find((entry) => entry.path === path);
      const opened = change.type === "open";
      const next: Bookmark = existing
        ? opened
          ? { ...existing, accessedAt: at, visits: existing.visits + 1 }
          : { ...existing, starred: change.starred }
        : {
            path,
            starred: opened ? false : change.starred,
            accessedAt: at,
            visits: opened ? 1 : 0,
          };
      bookmarks.set(userId, [
        ...list.filter((entry) => entry.path !== path),
        next,
      ]);
    },
    async listAppPasswords(userId) {
      return [...passwords.values()].filter(
        (password) => password.userId === userId,
      );
    },
    async addAppPassword(password) {
      passwords.set(password.id, password);
    },
    async findAppPassword(hash) {
      return (
        [...passwords.values()].find(
          (password) => password.tokenHash === hash,
        ) ?? null
      );
    },
    async removeAppPassword(id, userId) {
      if (passwords.get(id)?.userId === userId) passwords.delete(id);
    },
    fileRequests,
    versions,
    async hasRecordsNear() {
      // Always worth a full claim here: the maps are small, and the claim checks every kind.
      return true;
    },
    async caseVariants(path) {
      const variants = new Set<string>();
      const lower = path.toLowerCase();
      for (const recorded of [
        ...[...grants.values()].map((grant) => grant.path),
        ...[...shares.values()].map((share) => share.path),
        ...[...bookmarks.values()].flat().map((bookmark) => bookmark.path),
        ...properties.keys(),
      ]) {
        const prefix = recorded.slice(0, path.length);
        if (
          prefix !== path &&
          prefix.toLowerCase() === lower &&
          (recorded.length === path.length || recorded[path.length] === "/")
        )
          variants.add(prefix);
      }
      return [...variants];
    },
    async claimVacant(path) {
      take(path);
      await versions.removeAt(path);
    },
    async addPendingChange(change) {
      pending.set(change.id, change);
    },
    async removePendingChange(id) {
      pending.delete(id);
    },
    async listPendingChanges() {
      return [...pending.values()];
    },
    async movePath(from, to, settles) {
      if (settles !== undefined) pending.delete(settles);
      take(to);
      versions.relocate(from, to);
      const moved = (value: string) =>
        isWithinPath(from, value) ? to + value.slice(from.length) : value;
      for (const grant of grants.values()) grant.path = moved(grant.path);
      for (const share of shares.values()) share.path = moved(share.path);
      for (const entries of bookmarks.values())
        for (const entry of entries) entry.path = moved(entry.path);
      for (const [path, entries] of [...properties])
        if (isWithinPath(from, path)) {
          properties.delete(path);
          properties.set(moved(path), entries);
        }
    },
  };
  /** Remove and return every record at or under a path. */
  function take(path: string) {
    const taken: Detached = {
      grants: [],
      shares: [],
      bookmarks: [],
      properties: [],
    };
    for (const [id, grant] of grants)
      if (isWithinPath(path, grant.path)) {
        taken.grants.push(grant);
        grants.delete(id);
      }
    for (const [token, share] of shares)
      if (isWithinPath(path, share.path)) {
        taken.shares.push(share);
        shares.delete(token);
      }
    for (const [userId, entries] of bookmarks) {
      for (const entry of entries)
        if (isWithinPath(path, entry.path))
          taken.bookmarks.push([userId, entry]);
      bookmarks.set(
        userId,
        entries.filter((entry) => !isWithinPath(path, entry.path)),
      );
    }
    for (const [propertyPath, entries] of [...properties])
      if (isWithinPath(path, propertyPath)) {
        taken.properties.push([propertyPath, entries]);
        properties.delete(propertyPath);
      }
    return taken;
  }
  return {
    store,
    users,
    grants,
    groups,
    shares,
    trash,
    properties,
    homes,
    homeContainers,
  };
}

/**
 * One index of `root`, brought in line with the disk before every query, as
 * the search worker keeps its own: tests always search the current disk, and
 * a page's cursor continues on the next query.
 */
export function crawlingSearchService(root: string): SearchService {
  let built: Promise<SearchIndex> | null = null;
  const current = async () => {
    if (!built) {
      const index = createSearchIndex();
      built = crawl(index, root).then(() => index);
      return built;
    }
    const index = await built;
    await reconcile(index, root, (work) => work());
    return index;
  };
  return {
    async search(request) {
      return { ...(await current()).search(request), complete: true };
    },
    async usage() {
      return (await current()).bytesAt("") ?? 0;
    },
  };
}
