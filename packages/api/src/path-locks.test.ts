import { describe, expect, it } from "bun:test";
import { createPathLocks, type HeldScope } from "./path-locks";

const drive = (path: string): HeldScope => ({ space: "drive", path });
const within = (parent: string, child: string) =>
  parent === "" || parent === child || child.startsWith(`${parent}/`);
const overlap = (a: HeldScope, b: HeldScope) =>
  a.space === b.space && (within(a.path, b.path) || within(b.path, a.path));

/** Resolves on the next turn, after any locks that can be granted have been. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("path locks", () => {
  it("serializes overlapping scopes and runs disjoint ones together", async () => {
    const locks = createPathLocks();
    const first = await locks.acquire([drive("a/b")]);
    const started: string[] = [];
    for (const path of ["a", "a/b", "a/b/c", "a/bc", "a-b", "x", ""])
      void locks.acquire([drive(path)]).then((release) => {
        started.push(path);
        release();
      });
    await settle();
    // A sibling sharing a prefix is disjoint and starts; ancestors, descendants and the root
    // conflict and wait. "a/bc" is free but waits behind the earlier request for "a".
    expect(started.sort()).toEqual(["a-b", "x"]);
    first();
    await settle();
    expect(started.sort()).toEqual([
      "",
      "a",
      "a-b",
      "a/b",
      "a/b/c",
      "a/bc",
      "x",
    ]);
  });

  it("keeps hierarchies apart", async () => {
    const locks = createPathLocks();
    const release = await locks.acquire([{ space: "trash", path: "" }]);
    let started = false;
    void locks.acquire([drive("")]).then(() => {
      started = true;
    });
    await settle();
    expect(started).toBe(true);
    release();
  });

  it("admits conflicting requests in arrival order, so neither large nor small ones starve", async () => {
    const locks = createPathLocks();
    const order: string[] = [];
    const hold = await locks.acquire([drive("docs/a")]);
    const run = (name: string, scopes: [HeldScope, ...HeldScope[]]) =>
      locks.acquire(scopes).then((release) => {
        order.push(name);
        return release;
      });
    // The folder waits for its child; a later child waits for the folder.
    const folder = run("folder", [drive("docs")]);
    const later = run("later child", [drive("docs/b")]);
    const unrelated = run("unrelated", [drive("photos")]);
    await settle();
    expect(order).toEqual(["unrelated"]);
    hold();
    (await folder)();
    (await later)();
    (await unrelated)();
    expect(order).toEqual(["unrelated", "folder", "later child"]);
  });

  it("grants all scopes of a request together, so reversed moves never deadlock", async () => {
    const locks = createPathLocks();
    const results = await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const [from, to] = index % 2 ? ["a", "b"] : ["b", "a"];
        const release = await locks.acquire([drive(from), drive(to)]);
        await settle();
        release();
        return index;
      }),
    );
    expect(results).toHaveLength(50);
    expect(locks.waiting).toBe(0);
  });

  it("never runs conflicting holders together under random concurrent load", async () => {
    const locks = createPathLocks();
    const paths = ["", "a", "a/b", "a/b/c", "a/bc", "b", "b/a", "c/d/e"];
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const active = new Set<HeldScope[]>();
    let violations = 0;
    let completed = 0;
    for (let wave = 0; wave < 100; wave++)
      await Promise.all(
        Array.from({ length: 100 }, async () => {
          const scopes = Array.from(
            { length: 1 + Math.floor(random() * 3) },
            (): HeldScope => ({
              space: random() < 0.8 ? "drive" : "trash",
              path: paths[Math.floor(random() * paths.length)] ?? "",
            }),
          );
          const [first, ...rest] = scopes;
          if (!first) return;
          const release = await locks.acquire([first, ...rest]);
          for (const other of active)
            if (other.some((a) => scopes.some((b) => overlap(a, b))))
              violations++;
          active.add(scopes);
          for (let turn = 0; turn < 3; turn++) await Promise.resolve();
          active.delete(scopes);
          release();
          completed++;
        }),
      );
    expect({ violations, completed, waiting: locks.waiting }).toEqual({
      violations: 0,
      completed: 10_000,
      waiting: 0,
    });
  });

  it("ignores a second release", async () => {
    const locks = createPathLocks();
    const release = await locks.acquire([drive("a")]);
    release();
    release();
    const again = await locks.acquire([drive("a")]);
    let waited = true;
    void locks.acquire([drive("a")]).then(() => {
      waited = false;
    });
    await settle();
    expect(waited).toBe(true);
    again();
  });
});
