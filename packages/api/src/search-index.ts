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

export type IndexedKind = "file" | "dir";

export type SearchHit = { path: string; type: IndexedKind };

export type SearchScope =
  | { type: "all" }
  /** Readable subtrees: a path is visible when it is, or is inside, one of these. */
  | { type: "grants"; paths: readonly string[] };

export type SearchRequest = {
  query: string;
  /** Only return entries inside this folder ("" is the drive root). */
  root: string;
  limit: number;
  scope: SearchScope;
};

export type SearchResult = { hits: SearchHit[]; truncated: boolean };

const ROOT = 0;
const NONE = -1;
const TOMBSTONE = -2;
const FREE = 0;
const FILE = 1;
const DIR = 2;
const SEPARATOR = "\0";
/** Delta entries scanned one by one before a compaction is worthwhile. */
const DELTA_LIMIT = 20_000;

const boundary = new Uint8Array(128);
for (const char of " _-.()[]+,@#&'") boundary[char.charCodeAt(0)] = 1;

/** NFC plus lowercase: what both names and queries are compared as. */
export const foldName = (value: string) => value.normalize("NFC").toLowerCase();

/** Queries are typed text; control characters can never match a name. */
export const foldQuery = (value: string) =>
  foldName(value.trim()).replace(/[\u0000-\u001f\u007f]/g, "");

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

export function createSearchIndex(initialCapacity = 1024) {
  let count = 1;
  let live = 0;
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
  let folded = Buffer.from(SEPARATOR);
  let raw = SEPARATOR;
  let foldedStarts = new Int32Array([1, 2]);
  let rawStarts = new Int32Array([1, 2]);
  let slotId = new Int32Array([ROOT]);
  let subtreeEnd = new Int32Array([1]);
  let slots = 1;
  // Names for entries added since compaction.
  const deltaNames = new Map<number, { raw: string; folded: string }>();

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
    deltaNames.set(id, { raw: name, folded: foldName(name) });
    const { slot } = probe(parentId, name);
    table[slot] = id;
    tableUsed++;
    live++;
    return id;
  };

  /** Lay out live entries depth-first and drop freed text. */
  const compact = () => {
    const order = new Int32Array(live + 1);
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
    const ends = new Int32Array(used);
    const size = new Int32Array(count);
    for (let slot = used - 1; slot >= 0; slot--) {
      const id = order[slot];
      size[id] += 1;
      ends[slot] = slot + size[id];
      if (id !== ROOT) size[parent[id]] += size[id];
    }
    // Folded bytes: compacted names are copied, delta names encoded once.
    const nextFoldedStarts = new Int32Array(used + 1);
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
    const nextFolded = Buffer.alloc(bytes);
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
    slotOf = nextSlotOf;
    deltaNames.clear();
    // Ids are unchanged, so the table stays valid; only shed tombstones.
    if (tableUsed > live * 2)
      rehash(Math.max(2048, 2 ** Math.ceil(Math.log2((live + 1) * 2))));
  };

  /** Disjoint compacted slot ranges a caller may see beneath `rootId`. */
  const visibleRanges = (rootId: number, granted: number[] | null) => {
    const rootSlot = slotOf[rootId];
    const within = (inner: number, outer: number) => {
      for (let current = inner; current !== NONE; current = parent[current])
        if (current === outer) return true;
      return false;
    };
    const ranges: [number, number][] = [];
    if (granted === null) {
      if (rootSlot !== NONE) ranges.push([rootSlot + 1, subtreeEnd[rootSlot]]);
      return ranges;
    }
    for (const grant of granted) {
      const top = within(grant, rootId)
        ? grant
        : within(rootId, grant)
          ? rootId
          : NONE;
      const slot = top === NONE ? NONE : slotOf[top];
      if (slot !== NONE)
        ranges.push([top === rootId ? slot + 1 : slot, subtreeEnd[slot]]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    return merged;
  };

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

    /** Compact once the delta is large enough to slow queries. */
    maybeCompact(threshold = DELTA_LIMIT) {
      // Geometric growth keeps a full crawl linear overall.
      if (
        deltaNames.size >= Math.max(threshold, slots / 4) ||
        count - live > live
      )
        compact();
    },

    compact,

    search({ query, root, limit, scope }: SearchRequest): SearchResult {
      const needle = foldQuery(query);
      const rootId = find(root);
      if (!needle || limit <= 0 || rootId === NONE || kinds[rootId] !== DIR)
        return { hits: [], truncated: false };
      const granted =
        scope.type === "grants"
          ? scope.paths.map(find).filter((id) => id !== NONE)
          : null;
      if (granted?.length === 0) return { hits: [], truncated: false };

      // Best `limit` hits by (tier, name length, layout order), kept sorted.
      const ranks = new Float64Array(limit);
      const ids = new Int32Array(limit);
      let kept = 0;
      let matched = 0;
      const keep = (id: number, rank: number) => {
        matched++;
        if (kept === limit && rank >= ranks[limit - 1]) return;
        let index = kept < limit ? kept++ : limit - 1;
        while (index > 0 && ranks[index - 1] > rank) {
          ranks[index] = ranks[index - 1];
          ids[index] = ids[index - 1];
          index--;
        }
        ranks[index] = rank;
        ids[index] = id;
      };
      const rankOf = (
        exact: boolean,
        length: number,
        at: number,
        before: number,
        order: number,
      ) =>
        (exact ? 0 : at === 0 ? 1 : before < 128 && boundary[before] ? 2 : 3) *
          2 ** 44 +
        length * 2 ** 32 +
        order;

      // A single character matches name prefixes only: infix hits would be
      // nearly every name and help nobody.
      const prefixOnly = needle.length === 1;
      const pattern = Buffer.from(prefixOnly ? SEPARATOR + needle : needle);
      const needleBytes = pattern.length - (prefixOnly ? 1 : 0);
      const shift = prefixOnly ? 1 : 0;
      for (const [first, end] of visibleRanges(rootId, granted)) {
        const stop = foldedStarts[end];
        let slot = first;
        let position = folded.indexOf(pattern, foldedStarts[first] - shift);
        while (position >= 0 && position + shift < stop) {
          const at = position + shift;
          // Gallop forward to the slot containing this match.
          if (foldedStarts[slot + 1] <= at) {
            let step = 1;
            while (slot + step < end && foldedStarts[slot + step + 1] <= at)
              step *= 2;
            let low = slot + (step >> 1);
            let high = Math.min(slot + step, end - 1);
            while (low < high) {
              const middle = (low + high + 1) >> 1;
              if (foldedStarts[middle] <= at) low = middle;
              else high = middle - 1;
            }
            slot = low;
          }
          const id = slotId[slot];
          if (kinds[id] !== FREE) {
            const start = foldedStarts[slot];
            const length = foldedStarts[slot + 1] - start - 1;
            keep(
              id,
              rankOf(
                length === needleBytes,
                length,
                at - start,
                folded[at - 1],
                slot,
              ),
            );
          }
          position = folded.indexOf(pattern, foldedStarts[slot + 1] - shift);
        }
      }

      // Delta entries: check visibility by walking ancestors.
      const grantSet = granted ? new Set(granted) : null;
      for (const [id, name] of deltaNames) {
        const at = name.folded.indexOf(needle);
        if (at < 0 || (prefixOnly && at !== 0) || id === rootId) continue;
        let inRoot = false;
        let inGrant = grantSet === null;
        for (let current = id; current !== NONE; current = parent[current]) {
          if (current === rootId) inRoot = true;
          if (grantSet?.has(current)) inGrant = true;
        }
        if (inRoot && inGrant)
          keep(
            id,
            rankOf(
              name.folded.length === needle.length,
              name.folded.length,
              at,
              name.folded.charCodeAt(at - 1),
              slots + id,
            ),
          );
      }

      const hits: SearchHit[] = [];
      for (let i = 0; i < kept; i++)
        hits.push({
          path: pathOf(ids[i]),
          type: kinds[ids[i]] === DIR ? "dir" : "file",
        });
      return { hits, truncated: matched > kept };
    },
  };
}

export type SearchIndex = ReturnType<typeof createSearchIndex>;
