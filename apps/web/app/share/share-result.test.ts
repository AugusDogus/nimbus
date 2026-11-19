import { expect, test } from "bun:test";
import { ShareResult } from "./share-result";

const open = (name: string): ShareResult => ({
  kind: "open",
  entry: { name, path: "", type: "file", size: 1, mtime: 1 },
  entries: [],
  expiresAt: null,
  mode: "download",
});

test("an open link's page is titled with the item's name, without its extension", () => {
  expect(ShareResult.title(open("Trip-Checklist-Thu-Nov-19.pdf"))).toBe(
    "Trip-Checklist-Thu-Nov-19",
  );
  expect(ShareResult.title(open("archive.tar.gz"))).toBe("archive.tar");
  expect(ShareResult.title(open("Photos 2026"))).toBe("Photos 2026");
  // A dot that starts the name or sits before a space is no extension.
  expect(ShareResult.title(open(".bashrc"))).toBe(".bashrc");
  expect(ShareResult.title(open("v1. final draft"))).toBe("v1. final draft");
});

test("a link that is not open names nothing", () => {
  expect(ShareResult.title({ kind: "locked" })).toBeNull();
  expect(
    ShareResult.title({ kind: "unavailable", message: "Gone." }),
  ).toBeNull();
});
