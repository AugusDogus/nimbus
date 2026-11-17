/**
 * Searches waiting in the search worker, taken in turn by caller: one
 * search from each caller with any waiting, oldest caller first, then
 * round again. So a caller's burst costs everyone else at most one of its
 * searches per turn, however many it sends.
 */
function create<T>() {
  /** Waiting searches per caller, oldest first; callers in the order of their turns. */
  const byCaller = new Map<string, Map<number, T>>();
  const callerOf = new Map<number, string>();
  return {
    add(id: number, caller: string, item: T) {
      let waiting = byCaller.get(caller);
      if (!waiting) byCaller.set(caller, (waiting = new Map<number, T>()));
      waiting.set(id, item);
      callerOf.set(id, caller);
    },
    /** Remove a search that has not been taken; false when there is none. */
    remove(id: number) {
      const caller = callerOf.get(id);
      if (caller === undefined) return false;
      callerOf.delete(id);
      const waiting = byCaller.get(caller);
      waiting?.delete(id);
      if (waiting?.size === 0) byCaller.delete(caller);
      return true;
    },
    /** The next search to run, or null when none waits. */
    take(): { id: number; item: T } | null {
      for (const [caller, waiting] of byCaller) {
        const first = waiting.entries().next();
        // The caller goes to the back for its next turn, if it has one.
        byCaller.delete(caller);
        if (first.done) continue;
        const [id, item] = first.value;
        waiting.delete(id);
        callerOf.delete(id);
        if (waiting.size) byCaller.set(caller, waiting);
        return { id, item };
      }
      return null;
    },
    get size() {
      return callerOf.size;
    },
  };
}

export type SearchQueue<T> = ReturnType<typeof create<T>>;

export const SearchQueue = { create } as const;
