import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accessFor } from "./access";
import { applyChange, crawl, indexedPath } from "./search-crawler";
import { createSearchIndex } from "./search-index";
import { provideSearchService, searchEntries } from "./search-service";

let root: string;
let previousRoot: string | undefined;
const names = (index: ReturnType<typeof createSearchIndex>, query: string) =>
  index.search({ query, root: "", limit: 100, scope: { type: "all" } }).hits.map((hit) => hit.path).sort();

beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-search-"));
  process.env.NIMBUS_DATA_ROOT = root;
  await mkdir(path.join(root, "docs/deep"), { recursive: true });
  await writeFile(path.join(root, "docs/deep/notes.txt"), "");
  await writeFile(path.join(root, "docs/report.txt"), "");
  await mkdir(path.join(root, ".nimbus/trash"), { recursive: true });
  await writeFile(path.join(root, ".nimbus/trash/notes-old.txt"), "");
  await mkdir(path.join(root, "docs/.NIMBUS"));
  await writeFile(path.join(root, "docs/.NIMBUS/notes-hidden.txt"), "");
  await symlink(path.join(root, "docs/report.txt"), path.join(root, "notes-link.txt"));
});
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true });
});

describe("search crawler", () => {
  it("indexes nested files and skips private storage and symbolic links", async () => {
    const index = createSearchIndex();
    await crawl(index, root);
    expect(names(index, "notes")).toEqual(["docs/deep/notes.txt"]);
    expect(names(index, "docs")).toEqual(["docs"]);
  });

  it("applies watcher changes, crawling folders that move in", async () => {
    const index = createSearchIndex();
    await crawl(index, root);
    await writeFile(path.join(root, "docs/notes-2.txt"), "");
    await applyChange(index, root, path.join(root, "docs/notes-2.txt"));
    await rm(path.join(root, "docs/deep/notes.txt"));
    await applyChange(index, root, path.join(root, "docs/deep/notes.txt"));
    expect(names(index, "notes")).toEqual(["docs/notes-2.txt"]);

    const outside = await mkdtemp(path.join(os.tmpdir(), "nimbus-incoming-"));
    await mkdir(path.join(outside, "album/2026"), { recursive: true });
    await writeFile(path.join(outside, "album/2026/notes-trip.txt"), "");
    await rename(path.join(outside, "album"), path.join(root, "album"));
    await rm(outside, { recursive: true });
    await applyChange(index, root, path.join(root, "album"));
    expect(names(index, "notes")).toEqual(["album/2026/notes-trip.txt", "docs/notes-2.txt"]);

    await rename(path.join(root, "album"), path.join(root, "photos"));
    await applyChange(index, root, path.join(root, "album"));
    await applyChange(index, root, path.join(root, "photos"));
    expect(names(index, "notes")).toEqual(["docs/notes-2.txt", "photos/2026/notes-trip.txt"]);
  });

  it("ignores private and outside paths", async () => {
    expect(indexedPath(root, path.join(root, ".nimbus/uploads/x"))).toBeNull();
    expect(indexedPath(root, path.join(root, "a/.Nimbus/x"))).toBeNull();
    expect(indexedPath(root, path.join(root, "../elsewhere"))).toBeNull();
    expect(indexedPath(root, root)).toBeNull();
    expect(indexedPath(root, path.join(root, "a/b.txt"))).toBe("a/b.txt");
  });
});

describe("searchEntries", () => {
  const reader = accessFor({ id: "reader", name: "Reader", email: "r@example.test", role: "user", banned: false }, [
    { id: "g", path: "docs/deep", permission: "read", subject: { type: "user", id: "reader" } },
  ]);

  it("re-checks permissions and drops hits that no longer exist", async () => {
    // A stale or faulty index must not leak paths outside the caller's grants.
    provideSearchService({
      search: async () => ({
        hits: [
          { path: "docs/report.txt", type: "file" },
          { path: "docs/deep/notes.txt", type: "file" },
          { path: "docs/deep/gone.txt", type: "file" },
        ],
        truncated: false,
        complete: true,
      }),
    });
    const result = await searchEntries(reader, "", "notes", 50);
    expect(result.entries.map((entry) => entry.path)).toEqual(["docs/deep/notes.txt"]);
    expect(result.entries[0]).toMatchObject({ type: "file", size: 0 });
  });

  it("asks the index only for the caller's grants", async () => {
    let scope: unknown;
    provideSearchService({
      search: async (request) => {
        scope = request.scope;
        return { hits: [], truncated: false, complete: true };
      },
    });
    await searchEntries(reader, "", "notes", 50);
    expect(scope).toEqual({ type: "grants", paths: ["docs/deep"] });
  });
});
