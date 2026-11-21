import { describe, expect, it } from "bun:test";
import { DropTarget, type DragPayload } from "./drop-target";
import type { FileEntry } from "./types";

const entry = (path: string, type: "dir" | "file" = "dir"): FileEntry => ({
  name: path.split("/").pop() ?? path,
  path,
  type,
  permission: "admin",
  mtime: null,
  size: null,
  fixed: false,
});
const moving = (...paths: string[]): DragPayload => ({
  kind: "entries",
  sources: paths.map((path) => entry(path)),
});
const folder = (path: string, writable = true) => ({ path, writable });

describe("dropping on a folder", () => {
  it("moves items into a writable folder elsewhere, the drive root included", () => {
    expect(DropTarget.verdict(moving("a/b/c"), folder("a"))).toEqual({
      kind: "move",
    });
    expect(DropTarget.verdict(moving("a/b/c", "a/b/d"), folder(""))).toEqual({
      kind: "move",
    });
    expect(DropTarget.hint({ kind: "move" }, folder(""))).toBe(
      "Move to “Files”",
    );
  });

  it("refuses the dragged folder itself and any folder inside it", () => {
    expect(DropTarget.verdict(moving("a/b"), folder("a/b"))).toEqual({
      kind: "refused",
      reason: "itself",
    });
    expect(DropTarget.verdict(moving("a/b"), folder("a/b/c/d"))).toEqual({
      kind: "refused",
      reason: "inside-itself",
    });
    // A sibling whose name starts with the folder's is not inside it.
    expect(DropTarget.verdict(moving("a/b"), folder("a/bc"))).toEqual({
      kind: "move",
    });
  });

  it("refuses a folder the account can only view, for moves and uploads", () => {
    expect(DropTarget.verdict(moving("a/b"), folder("x", false))).toEqual({
      kind: "refused",
      reason: "read-only",
    });
    expect(DropTarget.verdict({ kind: "files" }, folder("x", false))).toEqual({
      kind: "refused",
      reason: "read-only",
    });
  });

  it("refuses the folder the items are already in", () => {
    expect(DropTarget.verdict(moving("a/b", "a/c"), folder("a"))).toEqual({
      kind: "refused",
      reason: "already-there",
    });
  });

  it("uploads files from the computer into any writable folder", () => {
    expect(DropTarget.verdict({ kind: "files" }, folder("a/b"))).toEqual({
      kind: "upload",
    });
    expect(DropTarget.hint({ kind: "upload" }, folder("a/b"))).toBe(
      "Upload to “b”",
    );
  });

  it("takes folder rows as targets, not files", () => {
    expect(DropTarget.ofEntry(entry("a/b"))).toEqual({
      path: "a/b",
      writable: true,
    });
    expect(DropTarget.ofEntry(entry("a/b.txt", "file"))).toBeNull();
    expect(DropTarget.ofEntry({ ...entry("a/b"), permission: "read" })).toEqual(
      { path: "a/b", writable: false },
    );
  });
});
