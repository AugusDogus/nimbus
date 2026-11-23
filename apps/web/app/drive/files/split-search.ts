/** A split view's params as the address spells them, all strings (see `SplitLayout`). */
export type SplitSearch = {
  right?: string;
  active?: string;
  ratio?: string;
  collapsed?: string;
};

const text = (search: Record<string, unknown>, key: keyof SplitSearch) => {
  const value = search[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * The split params of a folder route's search, for `validateSearch`; everything else is dropped.
 * Its own module, so the routes load nothing else of the split view.
 */
export function validateSplitSearch(
  search: Record<string, unknown>,
): SplitSearch {
  return {
    right: text(search, "right"),
    active: text(search, "active"),
    ratio: text(search, "ratio"),
    collapsed: text(search, "collapsed"),
  };
}
