/** How long after a transfer its items count as just arrived, in ms: their highlight's length. */
const freshMs = 1700;

const arrived = new Map<string, number>();

/**
 * Items a transfer just put in a folder, by path, so their rows there are highlighted once as
 * the listing shows them: the person sees where what they moved or copied landed.
 */
export const Arrivals = {
  record(paths: readonly string[]) {
    const now = performance.now();
    for (const path of paths) arrived.set(path, now);
  },
  /** Whether the item at `path` arrived moments ago; its row is highlighted as it shows. */
  has(path: string): boolean {
    const at = arrived.get(path);
    if (at === undefined) return false;
    if (performance.now() - at <= freshMs) return true;
    arrived.delete(path);
    return false;
  },
} as const;
