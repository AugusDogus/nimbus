/**
 * In-memory filename index for the whole data root.
 *
 * Compaction lays every live name out in depth-first order twice: case-folded
 * as UTF-8 bytes for matching (native `Buffer.indexOf`, and half the memory of
 * a UTF-16 string once any name is non-Latin), and raw for display. Each folder's
 * subtree is therefore a contiguous range, so a query scoped to a folder or
 * to a user's grants is one native `indexOf` scan over only what that user
 * may see. Entries added since the last compaction sit in a small delta that
 * is scanned separately. Tree structure, child lookup and offsets live in
 * typed arrays; strings are only kept per entry for the delta.
 *
 * Ids are never reused before the next rebuild. Removing an entry frees it
 * immediately; its compacted text is skipped until the next compaction.
 *
 * Each entry also carries a byte count: a file's size, or the total of
 * everything beneath a folder, kept current as sizes change, so the root holds
 * the drive's storage usage and any folder's total is one lookup.
 */

import { randomInt } from "node:crypto";
import { SearchWords } from "./search-words";
import { plain } from "./search-text";
import {
  createSearchState,
  foldName,
  prepareSearch,
  runSearch,
  scanCompacted,
  type IndexView,
  type IndexedKind,
  type SearchLayout,
  type SearchRequest,
  type SearchResult,
  type VisibleRange,
  type ScanPlan,
  type Stopped,
} from "./search-query";

export {
  foldName,
  foldQuery,
  type HistoryEntry,
  type IndexedKind,
  type SearchDepth,
  type SearchHit,
  type SearchMatch,
  type SearchRequest,
  type SearchResult,
  type SearchScope,
} from "./search-query";

const ROOT = 0;
const NONE = -1;
const TOMBSTONE = -2;
const FREE = 0;
const FILE = 1;
const DIR = 2;
const SEPARATOR = "\0";
/** Delta entries scanned one by one before a compaction is worthwhile. */
const DELTA_LIMIT = 20_000;

const growInt32 = (
  array: Int32Array<ArrayBuffer>,
  size: number,
  fill = 0,
): Int32Array<ArrayBuffer> => {
  if (size <= array.length) return array;
  const next = new Int32Array(Math.max(size, array.length * 2)).fill(fill);
  next.set(array);
  return next;
};

const growFloat64 = (
  array: Float64Array<ArrayBuffer>,
  size: number,
): Float64Array<ArrayBuffer> => {
  if (size <= array.length) return array;
  const next = new Float64Array(Math.max(size, array.length * 2));
  next.set(array);
  return next;
};

const growUint8 = (
  array: Uint8Array<ArrayBuffer>,
  size: number,
): Uint8Array<ArrayBuffer> => {
  if (size <= array.length) return array;
  const next = new Uint8Array(Math.max(size, array.length * 2));
  next.set(array);
  return next;
};

const hashName = (parentId: number, name: string) => {
  let hash = 0x811c9dc5 ^ Math.imul(parentId, 0x9e3779b1);
  for (let i = 0; i < name.length; i++)
    hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
  return hash >>> 0;
};

/**
 * Layout generations, distinct across every index this process builds. They
 * start at random, so a page cursor from an earlier run of the search worker
 * never names one of this run's layouts.
 */
let nextGeneration = randomInt(1, 2 ** 47);

export function createSearchIndex(initialCapacity = 1024) {
  let count = 1;
  let live = 0;
  /** Bumped by every change searches could see, so a scan elsewhere can tell it went stale. */
  let changes = 0;
  let parent = new Int32Array(initialCapacity);
  let firstChild = new Int32Array(initialCapacity);
  let nextSibling = new Int32Array(initialCapacity);
  let previousSibling = new Int32Array(initialCapacity);
  let kinds = new Uint8Array(initialCapacity);
  /** File size, or the total beneath a folder. Float64 keeps byte totals exact up to 8 PiB. */
  let bytes = new Float64Array(initialCapacity);
  /** id → compacted slot, or NONE for delta and freed entries. */
  let slotOf = new Int32Array(initialCapacity).fill(NONE);

  // Compacted layout, in depth-first slot order.
  // Compaction puts the arrays search scans on shared memory, so scan workers
  // can read them in place (search-scan-pool.ts).
  let folded: Buffer = Buffer.from(SEPARATOR);
  let raw = SEPARATOR;
  let foldedStarts: Int32Array = new Int32Array([1, 2]);
  let rawStarts = new Int32Array([1, 2]);
  let slotId: Int32Array = new Int32Array([ROOT]);
  let subtreeEnd: Int32Array = new Int32Array([1]);
  let slots = 1;
  /** Slots of the layout removed since it was built, whose text scans still pass over. */
  let deadSlots = 0;
  /** The arrays above as one value, replaced whenever compaction replaces them. */
  let layout: SearchLayout = {
    folded,
    foldedStarts,
    slotId,
    subtreeEnd,
    parentSlot: new Int32Array([NONE]),
    dead: new Uint8Array(1),
    slots,
    generation: nextGeneration++,
    postingStart: new Int32Array([0]),
    postingSlots: new Int32Array(0),
    plain: Buffer.from(SEPARATOR),
    plainStarts: new Int32Array([1]),
    plainSlot: new Int32Array(0),
    plainLead: new Uint8Array(0),
  };
  // Names for entries added since compaction.
  const deltaNames = new Map<
    number,
    { raw: string; folded: string; plain: string | null }
  >();
  /** Which names hold each word, for the fuzzy layer (search-words.ts). */
  const words = SearchWords.create();
  /** The layout before the last compaction, for page cursors ranked in it. */
  let previous: IndexView["previous"] = null;
  /**
   * Which folder on disk each listed folder was, so a crawler can tell a
   * folder replaced under the same name. Ids are not reused before a
   * rebuild, which starts a new index, so entries for removed ids are inert.
   */
  const identities = new Map<number, string>();

  // Open-addressed (parent, name) → id table.
  let table = new Int32Array(2048).fill(NONE);
  let tableUsed = 0;

  parent[ROOT] = NONE;
  firstChild[ROOT] = NONE;
  nextSibling[ROOT] = NONE;
  previousSibling[ROOT] = NONE;
  kinds[ROOT] = DIR;
  slotOf[ROOT] = 0;

  const nameOf = (id: number) => {
    const slot = slotOf[id];
    if (slot === NONE) return deltaNames.get(id)?.raw ?? "";
    return raw.slice(rawStarts[slot], rawStarts[slot + 1] - 1);
  };

  const probe = (parentId: number, name: string) => {
    const mask = table.length - 1;
    let index = hashName(parentId, name) & mask;
    let firstFree = NONE;
    for (;;) {
      const id = table[index];
      if (id === NONE)
        return { found: NONE, slot: firstFree === NONE ? index : firstFree };
      if (id === TOMBSTONE) {
        if (firstFree === NONE) firstFree = index;
      } else if (parent[id] === parentId && nameOf(id) === name)
        return { found: id, slot: index };
      index = (index + 1) & mask;
    }
  };

  const rehash = (size: number) => {
    table = new Int32Array(size).fill(NONE);
    tableUsed = 0;
    const mask = size - 1;
    for (let id = 1; id < count; id++) {
      if (kinds[id] === FREE) continue;
      let index = hashName(parent[id], nameOf(id)) & mask;
      while (table[index] !== NONE) index = (index + 1) & mask;
      table[index] = id;
      tableUsed++;
    }
  };

  const unhash = (id: number) => {
    const { found, slot } = probe(parent[id], nameOf(id));
    if (found === id) table[slot] = TOMBSTONE;
  };

  const childId = (parentId: number, name: string) =>
    probe(parentId, name).found;

  const find = (relative: string) => {
    if (!relative) return ROOT;
    const segments = relative.split("/");
    let id = ROOT;
    for (let i = 0; i < segments.length; i++) {
      id = childId(id, segments[i]);
      if (id === NONE) return NONE;
      if (i < segments.length - 1 && kinds[id] !== DIR) return NONE;
    }
    return id;
  };

  const pathOf = (id: number) => {
    const segments: string[] = [];
    for (let current = id; current > ROOT; current = parent[current])
      segments.push(nameOf(current));
    return segments.reverse().join("/");
  };

  const ensureCapacity = (size: number) => {
    parent = growInt32(parent, size);
    firstChild = growInt32(firstChild, size);
    nextSibling = growInt32(nextSibling, size);
    previousSibling = growInt32(previousSibling, size);
    kinds = growUint8(kinds, size);
    bytes = growFloat64(bytes, size);
    slotOf = growInt32(slotOf, size, NONE);
  };

  /** Change an entry's own byte count and every ancestor's total by `delta`. */
  const addBytes = (id: number, delta: number) => {
    if (delta === 0) return;
    for (let current = id; current !== NONE; current = parent[current])
      bytes[current] += delta;
  };

  function remove(id: number) {
    if (id === ROOT || kinds[id] === FREE) return;
    changes++;
    // The subtree's total leaves its ancestors once; freed entries are zeroed below.
    addBytes(parent[id], -bytes[id]);
    const before = previousSibling[id];
    const after = nextSibling[id];
    if (before === NONE) firstChild[parent[id]] = after;
    else nextSibling[before] = after;
    if (after !== NONE) previousSibling[after] = before;
    // Iterative walk: deep trees must not overflow the stack.
    const pending = [id];
    while (pending.length) {
      const current = pending.pop();
      if (current === undefined) break;
      for (
        let child = firstChild[current];
        child !== NONE;
        child = nextSibling[child]
      )
        pending.push(child);
      unhash(current);
      kinds[current] = FREE;
      // Scans of the layout skip it from now on.
      if (slotOf[current] !== NONE) {
        layout.dead[slotOf[current]] = 1;
        deadSlots++;
      }
      bytes[current] = 0;
      slotOf[current] = NONE;
      deltaNames.delete(current);
      live--;
    }
  }

  const insert = (parentId: number, name: string, kind: IndexedKind) => {
    // A crawler may still hold the id of a folder removed meanwhile.
    if (parentId === NONE || kinds[parentId] !== DIR) return NONE;
    const code = kind === "dir" ? DIR : FILE;
    const existing = childId(parentId, name);
    if (existing !== NONE) {
      if (kinds[existing] === code) return existing;
      remove(existing);
    }
    if ((tableUsed + 1) * 2 > table.length) rehash(table.length * 2);
    changes++;
    const id = count++;
    ensureCapacity(count);
    kinds[id] = code;
    bytes[id] = 0;
    parent[id] = parentId;
    firstChild[id] = NONE;
    previousSibling[id] = NONE;
    const head = firstChild[parentId];
    nextSibling[id] = head;
    if (head !== NONE) previousSibling[head] = id;
    firstChild[parentId] = id;
    slotOf[id] = NONE;
    const foldedName = foldName(name);
    const plainName = plain(foldedName);
    deltaNames.set(id, {
      raw: name,
      folded: foldedName,
      plain: plainName === foldedName ? null : plainName,
    });
    words.add(id, name);
    const { slot } = probe(parentId, name);
    table[slot] = id;
    tableUsed++;
    live++;
    return id;
  };

  /** Lay out live entries depth-first and drop freed text. */
  const compact = () => {
    changes++;
    const previousLayout = layout;
    const sharedInt32 = (length: number) =>
      new Int32Array(new SharedArrayBuffer(length * 4));
    const order = sharedInt32(live + 1);
    const nextSlotOf = new Int32Array(slotOf.length).fill(NONE);
    let used = 0;
    const stack = [ROOT];
    while (stack.length) {
      const id = stack.pop();
      if (id === undefined) break;
      nextSlotOf[id] = used;
      order[used++] = id;
      for (
        let child = firstChild[id];
        child !== NONE;
        child = nextSibling[child]
      )
        stack.push(child);
    }
    const ends = sharedInt32(used);
    const size = new Int32Array(count);
    for (let slot = used - 1; slot >= 0; slot--) {
      const id = order[slot];
      size[id] += 1;
      ends[slot] = slot + size[id];
      if (id !== ROOT) size[parent[id]] += size[id];
    }
    // Folded bytes: compacted names are copied, delta names encoded once.
    const nextFoldedStarts = sharedInt32(used + 1);
    let bytes = 1;
    for (let slot = 0; slot < used; slot++) {
      const id = order[slot];
      const delta = deltaNames.get(id);
      const previous = slotOf[id];
      nextFoldedStarts[slot] = bytes;
      bytes +=
        (delta
          ? Buffer.byteLength(delta.folded)
          : foldedStarts[previous + 1] - foldedStarts[previous] - 1) + 1;
    }
    nextFoldedStarts[used] = bytes;
    const nextFolded = Buffer.from(new SharedArrayBuffer(bytes));
    const rawParts = new Array<string>(used);
    for (let slot = 0; slot < used; slot++) {
      const id = order[slot];
      const delta = deltaNames.get(id);
      const previous = slotOf[id];
      if (delta) {
        rawParts[slot] = delta.raw;
        nextFolded.write(delta.folded, nextFoldedStarts[slot]);
      } else {
        rawParts[slot] = raw.slice(
          rawStarts[previous],
          rawStarts[previous + 1] - 1,
        );
        folded.copy(
          nextFolded,
          nextFoldedStarts[slot],
          foldedStarts[previous],
          foldedStarts[previous + 1] - 1,
        );
      }
    }
    const nextRawStarts = new Int32Array(used + 1);
    let offset = 1;
    for (let slot = 0; slot < used; slot++) {
      nextRawStarts[slot] = offset;
      offset += rawParts[slot].length + 1;
    }
    nextRawStarts[used] = offset;
    folded = nextFolded;
    foldedStarts = nextFoldedStarts;
    rawStarts = nextRawStarts;
    raw = SEPARATOR + rawParts.join(SEPARATOR) + SEPARATOR;
    slotId = order.subarray(0, used);
    subtreeEnd = ends;
    slots = used;
    deadSlots = 0;
    // Plain names, kept only where they differ: added ones carry theirs, and
    // the rest are copied from the old layout, whose surviving slots keep
    // their order.
    const plainSlots: number[] = [];
    const plainSources: (string | number)[] = [];
    const plainLeads: number[] = [];
    let plainBytes = 1;
    let oldEntry = 0;
    const oldPlainSlot = previousLayout.plainSlot;
    for (let slot = 0; slot < used; slot++) {
      const id = order[slot];
      const delta = deltaNames.get(id);
      if (delta) {
        if (delta.plain === null) continue;
        plainSlots.push(slot);
        plainSources.push(delta.plain);
        plainLeads.push(
          delta.plain.codePointAt(0) === delta.folded.codePointAt(0) ? 0 : 1,
        );
        plainBytes += Buffer.byteLength(delta.plain) + 1;
        continue;
      }
      const previous = slotOf[id];
      while (
        oldEntry < oldPlainSlot.length &&
        (oldPlainSlot[oldEntry] ?? 0) < previous
      )
        oldEntry++;
      if (oldPlainSlot[oldEntry] !== previous) continue;
      plainSlots.push(slot);
      plainSources.push(oldEntry);
      plainLeads.push(previousLayout.plainLead[oldEntry] ?? 0);
      plainBytes +=
        (previousLayout.plainStarts[oldEntry + 1] ?? 0) -
        (previousLayout.plainStarts[oldEntry] ?? 0);
    }
    const nextPlain = Buffer.from(new SharedArrayBuffer(plainBytes));
    const nextPlainStarts = sharedInt32(plainSlots.length + 1);
    let plainAt = 1;
    plainSources.forEach((source, entry) => {
      nextPlainStarts[entry] = plainAt;
      plainAt +=
        (typeof source === "string"
          ? nextPlain.write(source, plainAt)
          : previousLayout.plain.copy(
              nextPlain,
              plainAt,
              previousLayout.plainStarts[source] ?? 0,
              (previousLayout.plainStarts[source + 1] ?? 1) - 1,
            )) + 1;
    });
    nextPlainStarts[plainSlots.length] = plainAt;
    const nextPlainSlot = sharedInt32(plainSlots.length);
    nextPlainSlot.set(plainSlots);
    const nextPlainLead = new Uint8Array(
      new SharedArrayBuffer(plainSlots.length),
    );
    nextPlainLead.set(plainLeads);
    const parentSlot = sharedInt32(used);
    for (let slot = 0; slot < used; slot++) {
      const id = order[slot];
      parentSlot[slot] = id === ROOT ? NONE : nextSlotOf[parent[id]];
    }
    words.compact(previousLayout.slotId, nextSlotOf);
    previous = {
      generation: previousLayout.generation,
      slots: previousLayout.slots,
      slotId: previousLayout.slotId,
      slotOf,
    };
    layout = {
      folded,
      foldedStarts,
      slotId,
      subtreeEnd,
      parentSlot,
      dead: new Uint8Array(new SharedArrayBuffer(used)),
      slots,
      generation: nextGeneration++,
      postingStart: words.base.postingStart,
      postingSlots: words.base.postingSlots,
      plain: nextPlain,
      plainStarts: nextPlainStarts,
      plainSlot: nextPlainSlot,
      plainLead: nextPlainLead,
    };
    slotOf = nextSlotOf;
    deltaNames.clear();
    // Ids are unchanged, so the table stays valid; only shed tombstones.
    if (tableUsed > live * 2)
      rehash(Math.max(2048, 2 ** Math.ceil(Math.log2((live + 1) * 2))));
  };

  /**
   * Disjoint compacted slot ranges a caller may see beneath `rootId`. Nested
   * grants merge into the outer one; ranges that only touch stay apart, so
   * each keeps the folder above it.
   */
  const visibleRanges = (
    rootId: number,
    granted: number[] | null,
  ): VisibleRange[] => {
    const rootSlot = slotOf[rootId];
    const within = (inner: number, outer: number) => {
      for (let current = inner; current !== NONE; current = parent[current])
        if (current === outer) return true;
      return false;
    };
    const ranges: VisibleRange[] = [];
    const whole = () => ({
      first: rootSlot + 1,
      end: subtreeEnd[rootSlot],
      outside: rootSlot,
    });
    if (granted === null) {
      if (rootSlot !== NONE) ranges.push(whole());
      return ranges;
    }
    for (const grant of granted) {
      const top = within(grant, rootId)
        ? grant
        : within(rootId, grant)
          ? rootId
          : NONE;
      const slot = top === NONE ? NONE : slotOf[top];
      if (slot === NONE) continue;
      ranges.push(
        top === rootId
          ? whole()
          : {
              first: slot,
              end: subtreeEnd[slot],
              outside: slotOf[parent[top]],
            },
      );
    }
    ranges.sort((a, b) => a.first - b.first);
    const merged: VisibleRange[] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range.first < last.end)
        last.end = Math.max(last.end, range.end);
      else merged.push(range);
    }
    return merged;
  };

  const view: IndexView = {
    get layout(): SearchLayout {
      return layout;
    },
    delta: deltaNames,
    find,
    isLive: (id) => id >= 0 && id < count && kinds[id] !== FREE,
    isFolder: (id) => id >= 0 && id < count && kinds[id] === DIR,
    parentOf: (id) => (id >= 0 && id < count ? parent[id] : NONE),
    slotOf: (id) => (id >= 0 && id < count ? slotOf[id] : NONE),
    pathOf,
    nameOf: (id) => (id >= 0 && id < count ? nameOf(id) : ""),
    foldedNameOf: (id) => {
      const slot = slotOf[id];
      if (slot === NONE) return deltaNames.get(id)?.folded ?? "";
      return folded.toString(
        "utf8",
        foldedStarts[slot],
        foldedStarts[slot + 1] - 1,
      );
    },
    visibleRanges,
    get previous() {
      return previous;
    },
    words,
  };
  const state = createSearchState();

  return {
    get size() {
      return live;
    },

    /**
     * Add or replace one entry, creating missing ancestor folders. A file's
     * `size` replaces its previous one; a folder's total comes from its contents.
     */
    add(relative: string, kind: IndexedKind, size = 0) {
      const segments = relative.split("/");
      let id = ROOT;
      for (let i = 0; i < segments.length - 1; i++)
        id = insert(id, segments[i], "dir");
      const added = insert(id, segments[segments.length - 1], kind);
      if (added !== NONE && kind === "file")
        addBytes(added, size - bytes[added]);
      return added;
    },

    /** Add a child by parent id, for crawlers that already hold the id. */
    addChild(parentId: number, name: string, kind: IndexedKind, size = 0) {
      const added = insert(parentId, name, kind);
      if (added !== NONE && kind === "file")
        addBytes(added, size - bytes[added]);
      return added;
    },

    /** Bytes in the files at or beneath a path: the drive's usage for "". Null when not indexed. */
    bytesAt(relative: string) {
      const id = find(relative);
      return id === NONE ? null : bytes[id];
    },

    /** Whether `id` is a folder still in the index, for walkers that hold ids across awaits. */
    isFolder(id: number) {
      return id >= 0 && id < count && kinds[id] === DIR;
    },

    /** The direct children of a folder, for reconciling it with a listing. */
    childrenOf(parentId: number) {
      const children: { id: number; name: string; kind: IndexedKind }[] = [];
      if (parentId < 0 || parentId >= count || kinds[parentId] !== DIR)
        return children;
      for (
        let child = firstChild[parentId];
        child !== NONE;
        child = nextSibling[child]
      )
        children.push({
          id: child,
          name: nameOf(child),
          kind: kinds[child] === DIR ? "dir" : "file",
        });
      return children;
    },

    /** The disk identity a crawler recorded when it last listed folder `id`. */
    identityOf(id: number) {
      return identities.get(id);
    },

    setIdentity(id: number, identity: string) {
      if (id >= 0 && id < count && kinds[id] === DIR)
        identities.set(id, identity);
    },

    /** The folders directly inside a folder, without reading the names of its files. */
    foldersIn(parentId: number) {
      const folders: { id: number; name: string }[] = [];
      if (parentId < 0 || parentId >= count || kinds[parentId] !== DIR)
        return folders;
      for (
        let child = firstChild[parentId];
        child !== NONE;
        child = nextSibling[child]
      )
        if (kinds[child] === DIR)
          folders.push({ id: child, name: nameOf(child) });
      return folders;
    },

    /** The files directly inside a folder, by id and name. */
    filesIn(parentId: number) {
      const files: { id: number; name: string }[] = [];
      if (parentId < 0 || parentId >= count || kinds[parentId] !== DIR)
        return files;
      for (
        let child = firstChild[parentId];
        child !== NONE;
        child = nextSibling[child]
      )
        if (kinds[child] === FILE)
          files.push({ id: child, name: nameOf(child) });
      return files;
    },

    /** Set file `id`'s size, for walkers that already hold its id. */
    setFileSize(id: number, size: number) {
      if (id >= 0 && id < count && kinds[id] === FILE)
        addBytes(id, size - bytes[id]);
    },

    /** Remove an entry by id, with everything beneath it. */
    removeId(id: number) {
      if (id > ROOT && id < count) remove(id);
    },

    /**
     * Id slots freed since the index was built. Ids are not reused, so sustained
     * churn grows the arrays until the index is rebuilt.
     */
    get freedIds() {
      return count - 1 - live;
    },

    /** Remove an entry and everything beneath it. Missing paths are ignored. */
    remove(relative: string) {
      const id = find(relative);
      if (id !== NONE) remove(id);
    },

    has(relative: string) {
      return find(relative) !== NONE;
    },

    kindOf(relative: string): IndexedKind | null {
      const id = find(relative);
      return id === NONE ? null : kinds[id] === DIR ? "dir" : "file";
    },

    /**
     * Compact once the delta, or the removed names scans still pass over, is
     * large enough to slow queries. Both count only changes since the last
     * compaction, so each compaction follows that many changes: geometric
     * growth keeps a full crawl linear overall, and churn never compacts on
     * every change. (Freed ids are reclaimed only by a rebuild.)
     */
    maybeCompact(threshold = DELTA_LIMIT) {
      const enough = Math.max(threshold, slots / 4);
      if (deltaNames.size >= enough || deadSlots >= enough) compact();
    },

    compact,

    /** Filename search; see search-query.ts for its layers and order. */
    search(request: SearchRequest): SearchResult {
      return runSearch(view, state, request);
    },

    /**
     * A search whose compacted scan the caller runs, on this thread with
     * `scanHere` or in scan workers, before calling its `finish`.
     */
    prepareSearch(request: SearchRequest) {
      return prepareSearch(view, request);
    },

    scanHere(
      layout: SearchLayout,
      plan: ScanPlan,
      limit: number,
      translate: ((rank: number) => number) | null = null,
      stopped?: Stopped,
    ) {
      return scanCompacted(state, layout, plan, limit, translate, stopped);
    },

    /** Changes so far; a different value after an await means the index moved meanwhile. */
    get changes() {
      return changes;
    },
  };
}

export type SearchIndex = ReturnType<typeof createSearchIndex>;
