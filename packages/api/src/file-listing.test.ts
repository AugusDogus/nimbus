import { describe, expect, it } from "bun:test";
import { FileListing, type ListedEntry } from "./file-listing";

const entries: ListedEntry[] = [
  {
    name: "docs",
    path: "team/docs",
    type: "dir",
    mtime: 10,
    size: 0,
    permission: "admin",
    fixed: true,
  },
  {
    name: "a b.txt",
    path: "team/a b.txt",
    type: "file",
    mtime: 1.5,
    size: 42,
    permission: "read",
    fixed: false,
  },
  {
    name: "😀.md",
    path: "team/😀.md",
    type: "file",
    mtime: 2,
    size: 7,
    permission: "write",
    fixed: false,
  },
];

describe("folder listings on the wire", () => {
  it("round-trips entries with stats, through JSON", () => {
    const listing = FileListing.encode("team", entries, true);
    expect(FileListing.decode(JSON.parse(JSON.stringify(listing)))).toEqual({
      ok: true,
      entries,
    });
  });

  it("sends home folders as the indices of a short list", () => {
    expect(FileListing.encode("team", entries, true).fixed).toEqual([0]);
  });

  it("round-trips entries without stats, and builds root paths from names alone", () => {
    const listing = FileListing.encode(
      "",
      entries.map((entry) => ({ ...entry, mtime: null, size: null })),
      false,
    );
    expect(listing.stats).toBeNull();
    expect(FileListing.entries(listing)).toEqual(
      entries.map((entry) => ({
        ...entry,
        path: entry.name,
        mtime: null,
        size: null,
      })),
    );
  });

  it("refuses listings that are malformed or whose columns disagree", () => {
    const good = FileListing.encode("team", entries, true);
    for (const bad of [
      null,
      [],
      { ...good, folder: 1 },
      { ...good, names: ["only one"] },
      { ...good, folders: [1, 0, 2] },
      { ...good, permissions: [0, 1] },
      { ...good, stats: { mtimes: [1, 2, 3], sizes: [1, "2", 3] } },
      { ...good, stats: { mtimes: [1, 2, Number.NaN], sizes: [1, 2, 3] } },
      { ...good, stats: "none" },
      { ...good, fixed: [3] },
      { ...good, fixed: [0.5] },
      { ...good, fixed: null },
    ])
      expect(FileListing.decode(bad)).toMatchObject({
        ok: false,
        error: { kind: "invalid-listing" },
      });
  });
});
