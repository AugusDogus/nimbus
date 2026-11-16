import { describe, expect, it } from "bun:test";
import type * as DirListCache from "./dir-list-cache";

// The limits are read at import, so each test imports a fresh copy, which TypeScript cannot type.
const isDirListCache = (module: unknown): module is typeof DirListCache =>
  typeof module === "object" &&
  module !== null &&
  "getDirEntries" in module &&
  "resetDirListCacheForTest" in module;

const loadDirListCache = async () => {
  process.env.NIMBUS_DIR_CACHE_MAX = "1";
  process.env.NIMBUS_DIR_CACHE_TTL_MS = "5";
  const module: unknown = await import(
    `./dir-list-cache.ts?test=${Date.now()}`
  );
  if (!isDirListCache(module))
    throw new Error("dir-list-cache.ts no longer exports its cache functions.");
  module.resetDirListCacheForTest();
  return module;
};

describe("dir-list-cache bounds", () => {
  it("evicts oldest entries when max size exceeded", async () => {
    const { getDirEntries, setDirEntries } = await loadDirListCache();
    setDirEntries("alpha", [{ name: "a", path: "alpha/a", type: "file" }], 1);
    setDirEntries("bravo", [{ name: "b", path: "bravo/b", type: "file" }], 2);
    expect(getDirEntries("alpha", 1)).toBeNull();
    expect(getDirEntries("bravo", 2)).not.toBeNull();
  });

  it("expires entries after TTL", async () => {
    const { getDirEntries, setDirEntries } = await loadDirListCache();
    setDirEntries(
      "charlie",
      [{ name: "c", path: "charlie/c", type: "file" }],
      3,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getDirEntries("charlie", 3)).toBeNull();
  });
});
