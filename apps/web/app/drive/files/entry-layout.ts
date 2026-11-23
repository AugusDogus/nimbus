/** Geometry, in CSS pixels, shared by the layout math and the rendered rows. */
export const entryGeometry = {
  list: { height: 48, gap: 4 },
  /**
   * Cards are at least `minWidth` wide and as many fit as the listing's width allows; their
   * height is `aspect` of their width, so they stay landscape at every width.
   */
  grid: { minWidth: 160, gap: 12, aspect: 3 / 4 },
  header: { height: 16, gap: 12 },
  sectionGap: 24,
} as const;

export type EntrySection<T> = { title: string; entries: readonly T[] };

/** How entries lay out across a row: how many per row, and how tall each row is. */
export type EntryTrack = { columns: number; height: number };

/** The list's track: one entry per row. */
const listTrack: EntryTrack = { columns: 1, height: entryGeometry.list.height };

/** The grid's track for a listing `width` pixels wide: fewer columns, never thinner cards. */
function gridTrack(width: number): EntryTrack {
  const { minWidth, gap, aspect } = entryGeometry.grid;
  const columns = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
  const cardWidth = (width - (columns - 1) * gap) / columns;
  return {
    columns,
    height: Math.round(Math.max(minWidth, cardWidth) * aspect),
  };
}

/** A positioned row: a section title, or a run of consecutive entries (one in list view). */
export type LayoutRow =
  | { kind: "header"; title: string; top: number; height: number }
  | {
      kind: "entries";
      start: number;
      count: number;
      top: number;
      height: number;
    };

export type EntryLayout<T> = {
  rows: readonly LayoutRow[];
  /** Entries in display order. Row `start` indexes into this list. */
  entries: readonly T[];
  /** Row index of each entry, by entry index. */
  rowByEntry: Int32Array;
  height: number;
  columns: number;
};

function build<T>(
  sections: readonly EntrySection<T>[],
  view: "list" | "grid",
  track: EntryTrack,
): EntryLayout<T> {
  const perRow = view === "grid" ? Math.max(1, track.columns) : 1;
  const item = {
    height: track.height,
    gap: view === "grid" ? entryGeometry.grid.gap : entryGeometry.list.gap,
  };
  const rows: LayoutRow[] = [];
  const entries: T[] = [];
  let top = 0;
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    if (rows.length > 0) top += entryGeometry.sectionGap;
    if (section.title) {
      rows.push({
        kind: "header",
        title: section.title,
        top,
        height: entryGeometry.header.height,
      });
      top += entryGeometry.header.height + entryGeometry.header.gap;
    }
    for (let offset = 0; offset < section.entries.length; offset += perRow) {
      if (offset > 0) top += item.gap;
      const count = Math.min(perRow, section.entries.length - offset);
      rows.push({
        kind: "entries",
        start: entries.length + offset,
        count,
        top,
        height: item.height,
      });
      top += item.height;
    }
    for (const entry of section.entries) entries.push(entry);
  }
  const rowByEntry = new Int32Array(entries.length);
  rows.forEach((row, index) => {
    if (row.kind === "entries")
      rowByEntry.fill(index, row.start, row.start + row.count);
  });
  return { rows, entries, rowByEntry, height: top, columns: perRow };
}

function rowOf<T>(layout: EntryLayout<T>, entryIndex: number) {
  return layout.rowByEntry[entryIndex] ?? -1;
}

/** First row whose bottom is below `y`. */
function firstEndingAfter(rows: readonly LayoutRow[], y: number) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const row = rows[middle];
    if (row && row.top + row.height <= y) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Rows intersecting `[top, bottom)` in layout coordinates, as a half-open index range. */
function rangeAt<T>(layout: EntryLayout<T>, top: number, bottom: number) {
  const start = firstEndingAfter(layout.rows, top);
  let end = start;
  while (
    end < layout.rows.length &&
    (layout.rows[end]?.top ?? Infinity) < bottom
  )
    end++;
  return { start, end };
}

export const EntryLayout = {
  build,
  rowOf,
  rangeAt,
  listTrack,
  gridTrack,
} as const;
