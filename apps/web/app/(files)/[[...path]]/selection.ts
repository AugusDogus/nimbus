/** Display order of a folder's entries, with constant-time position lookup for range selection. */
export type SelectionOrder = {
  readonly paths: readonly string[];
  readonly index: ReadonlyMap<string, number>;
};

/**
 * Selected entries of one folder. The anchor is where shift-range selection starts: the last
 * item clicked or toggled. Instances are immutable; operations return new values.
 */
export type Selection = {
  readonly paths: ReadonlySet<string>;
  readonly anchor: string | null;
};

const empty: Selection = { paths: new Set(), anchor: null };

function order(paths: readonly string[]): SelectionOrder {
  return {
    paths,
    index: new Map(paths.map((path, position) => [path, position])),
  };
}

function only(path: string): Selection {
  return { paths: new Set([path]), anchor: path };
}

function toggle(selection: Selection, path: string): Selection {
  const paths = new Set(selection.paths);
  if (!paths.delete(path)) paths.add(path);
  return { paths, anchor: path };
}

/** Select from the anchor to `path`. `extend` keeps the existing selection (ctrl/cmd+shift). */
function range(
  selection: Selection,
  entries: SelectionOrder,
  path: string,
  extend: boolean,
): Selection {
  const from =
    selection.anchor === null ? undefined : entries.index.get(selection.anchor);
  const to = entries.index.get(path);
  if (from === undefined || to === undefined) return only(path);
  const paths = new Set(extend ? selection.paths : []);
  for (
    let position = Math.min(from, to);
    position <= Math.max(from, to);
    position++
  ) {
    const entry = entries.paths[position];
    if (entry !== undefined) paths.add(entry);
  }
  return { paths, anchor: selection.anchor };
}

function all(entries: SelectionOrder): Selection {
  return { paths: new Set(entries.paths), anchor: entries.paths[0] ?? null };
}

/** Drop entries that left the folder. Returns the same instance when nothing changed. */
function retain(selection: Selection, entries: SelectionOrder): Selection {
  let changed =
    selection.anchor !== null && !entries.index.has(selection.anchor);
  const paths = new Set<string>();
  for (const path of selection.paths) {
    if (entries.index.has(path)) paths.add(path);
    else changed = true;
  }
  if (!changed) return selection;
  return {
    paths,
    anchor:
      selection.anchor !== null && entries.index.has(selection.anchor)
        ? selection.anchor
        : null,
  };
}

export const Selection = {
  empty,
  order,
  only,
  toggle,
  range,
  all,
  retain,
} as const;
