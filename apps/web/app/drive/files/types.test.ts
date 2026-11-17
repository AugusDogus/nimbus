import { describe, expect, it } from "bun:test";
import { FileEntry } from "./types";

const file: FileEntry = {
  name: "notes.txt",
  path: "projects/notes.txt",
  type: "file",
  permission: "write",
  fixed: false,
  mtime: null,
  size: null,
};
const folder: FileEntry = {
  ...file,
  name: "archive",
  path: "archive",
  type: "dir",
  permission: "admin",
};

describe("file move eligibility", () => {
  it("allows writable files and requires admin access to move folders", () => {
    expect(FileEntry.canMove(file)).toBe(true);
    expect(FileEntry.canMove(folder)).toBe(true);
    expect(FileEntry.canMove({ ...file, permission: "read" })).toBe(false);
    // Home folders, and the folder holding them, stay where they are.
    expect(FileEntry.canMove({ ...folder, fixed: true })).toBe(false);
    expect(FileEntry.canTrash({ ...folder, fixed: true })).toBe(false);
    expect(FileEntry.canTrash(folder)).toBe(true);
    expect(FileEntry.canMoveInto(file, { ...folder, fixed: true })).toBe(true);
    expect(FileEntry.canMove({ ...folder, permission: "write" })).toBe(false);
    expect(FileEntry.canMove({ ...folder, path: "" })).toBe(false);
  });

  it("accepts writable folders and rejects read-only or file destinations", () => {
    expect(FileEntry.canMoveInto(file, folder)).toBe(true);
    expect(
      FileEntry.canMoveInto(file, { ...folder, permission: "write" }),
    ).toBe(true);
    expect(FileEntry.canMoveInto(file, { ...folder, permission: "read" })).toBe(
      false,
    );
    expect(FileEntry.canMoveInto(file, { ...folder, type: "file" })).toBe(
      false,
    );
    expect(FileEntry.canMoveInto({ ...file, permission: "read" }, folder)).toBe(
      false,
    );
  });

  it("rejects moves into the source, its descendants, or its current parent", () => {
    expect(FileEntry.canMoveInto(folder, folder)).toBe(false);
    expect(
      FileEntry.canMoveInto(folder, { ...folder, path: "archive/nested" }),
    ).toBe(false);
    expect(FileEntry.canMoveInto(file, { ...folder, path: "projects" })).toBe(
      false,
    );
    expect(FileEntry.canMoveInto(folder, { ...folder, path: "" })).toBe(false);
    expect(
      FileEntry.canMoveInto(folder, { ...folder, path: "archive-old" }),
    ).toBe(true);
  });

  it("keeps only the outermost of selected items, since a folder's action covers its contents", () => {
    const at = (path: string, type = "file") => ({
      ...file,
      path,
      name: path.split("/").pop() ?? path,
      type,
    });
    const selected = [
      at("a", "dir"),
      at("a/b.txt"),
      at("a/c", "dir"),
      at("a/c/d.txt"),
      at("ab.txt"),
      at("x/y.txt"),
    ];
    expect(FileEntry.outermost(selected).map((entry) => entry.path)).toEqual([
      "a",
      "ab.txt",
      "x/y.txt",
    ]);
  });
});
