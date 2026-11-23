/**
 * Exclusive locks on subtrees of named hierarchies, such as the drive's paths
 * or trash items. A lock on `a/b` conflicts with locks on `a`, `a/b` and
 * anything under `a/b`; locks on disjoint subtrees are held at once.
 *
 * A request names every scope it needs and gets all of them together or none,
 * so no request holds one scope while it waits for another, and two requests
 * can never deadlock. Requests are admitted in arrival order among those that
 * conflict: a later request may start before an earlier one only when they
 * share no scope, so neither a large operation nor a stream of small ones can
 * starve the other.
 *
 * Holders are counted in a trie of path segments, with totals per subtree, so
 * a conflict check walks only the requested path. Not reentrant: code holding
 * locks must not request more.
 */
export type HeldScope = {
  /** The hierarchy, for example "drive" or "trash". */
  space: string;
  /** "/"-separated segments; "" is the whole hierarchy. */
  path: string;
};

type Node = {
  /** Locks held exactly here. */
  here: number;
  /** Locks held here or anywhere below. */
  below: number;
  children: Map<string, Node>;
};

const node = (): Node => ({ here: 0, below: 0, children: new Map() });
const segmentsOf = (path: string) => (path ? path.split("/") : []);

/** Counted holders of each scope. */
class Holders {
  private readonly spaces = new Map<string, Node>();

  conflicts(scope: HeldScope) {
    let current = this.spaces.get(scope.space);
    for (const segment of segmentsOf(scope.path)) {
      if (!current) return false;
      // A lock on an ancestor covers this scope.
      if (current.here > 0) return true;
      current = current.children.get(segment);
    }
    // A lock here or on any descendant is inside this scope.
    return (current?.below ?? 0) > 0;
  }

  add(scope: HeldScope) {
    let current: Node | undefined = this.spaces.get(scope.space);
    if (!current) {
      current = node();
      this.spaces.set(scope.space, current);
    }
    current.below++;
    for (const segment of segmentsOf(scope.path)) {
      let child: Node | undefined = current.children.get(segment);
      if (!child) {
        child = node();
        current.children.set(segment, child);
      }
      child.below++;
      current = child;
    }
    current.here++;
  }

  remove(scope: HeldScope) {
    const root = this.spaces.get(scope.space);
    if (!root) return;
    const chain: Node[] = [root];
    for (const segment of segmentsOf(scope.path)) {
      const child = chain[chain.length - 1]?.children.get(segment);
      if (!child) return;
      chain.push(child);
    }
    const leaf = chain[chain.length - 1];
    if (leaf) leaf.here--;
    for (const entry of chain) entry.below--;
    // Prune branches no lock passes through any more.
    const segments = segmentsOf(scope.path);
    for (let depth = segments.length; depth > 0; depth--) {
      const child = chain[depth];
      const segment = segments[depth - 1];
      if (child && child.below === 0 && segment !== undefined)
        chain[depth - 1]?.children.delete(segment);
    }
    if (root.below === 0) this.spaces.delete(scope.space);
  }
}

type Waiter = {
  scopes: readonly HeldScope[];
  start: (release: Release) => void;
};

export type Release = () => void;

/** Whether holding `held` also holds `needed`: the same hierarchy, at or above it. */
export function covers(held: HeldScope, needed: HeldScope) {
  if (held.space !== needed.space) return false;
  if (held.path === "" || held.path === needed.path) return true;
  return needed.path.startsWith(`${held.path}/`);
}

export function createPathLocks() {
  const active = new Holders();
  /** Scopes of queued requests: a newcomer conflicting with one waits behind it. */
  let queued = new Holders();
  let waiting: Waiter[] = [];

  const grant = (scopes: readonly HeldScope[]): Release => {
    for (const scope of scopes) active.add(scope);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const scope of scopes) active.remove(scope);
      if (waiting.length) admit();
    };
  };

  const admit = () => {
    const blocked = new Holders();
    const remaining: Waiter[] = [];
    for (const waiter of waiting) {
      if (
        waiter.scopes.some(
          (scope) => active.conflicts(scope) || blocked.conflicts(scope),
        )
      ) {
        remaining.push(waiter);
        for (const scope of waiter.scopes) blocked.add(scope);
      } else waiter.start(grant(waiter.scopes));
    }
    waiting = remaining;
    queued = blocked;
  };

  return {
    /** Wait until every scope is free, then hold them all until the release is called. */
    acquire(scopes: readonly [HeldScope, ...HeldScope[]]): Promise<Release> {
      const owned = [...scopes];
      if (
        owned.every(
          (scope) => !active.conflicts(scope) && !queued.conflicts(scope),
        )
      )
        return Promise.resolve(grant(owned));
      return new Promise((resolve) => {
        waiting.push({ scopes: owned, start: resolve });
        for (const scope of owned) queued.add(scope);
      });
    },
    /** Requests waiting for a conflicting holder, for tests and diagnostics. */
    get waiting() {
      return waiting.length;
    },
  };
}

export type PathLocks = ReturnType<typeof createPathLocks>;
