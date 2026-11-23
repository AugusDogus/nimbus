import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { libraryItems } from "../db/library-schema";
import { Libraries } from "./libraries";
import { LibraryAccess } from "./library-access";
import {
  LibraryCatalog,
  MAX_TOMBSTONES,
  TOMBSTONE_RETENTION_MS,
} from "./library-catalog";
import { openLibraryTest, type LibraryTest } from "./library-testing";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const old = new Date(Date.UTC(2025, 2, 14, 9, 30));

let t: LibraryTest;
let libraryId: string;

beforeEach(async () => {
  t = await openLibraryTest();
  await mkdir(t.drive.absolute("library/kitchen/Guides"), { recursive: true });
  await mkdir(t.drive.absolute("library/garage"), { recursive: true });
});
afterEach(() => t.close());

/** Write `relative` with `content`, modified at `when`. */
async function file(relative: string, content: string, when = old) {
  await mkdir(t.drive.absolute(relative.split("/").slice(0, -1).join("/")), {
    recursive: true,
  });
  await writeFile(t.drive.absolute(relative), content);
  await utimes(t.drive.absolute(relative), when, when);
}

async function create(folders = ["library/kitchen"]) {
  const created = await Libraries.create(
    t.ctx,
    await t.drive.access("owner"),
    false,
    { title: "Kitchen", folders },
  );
  if (!created.ok) throw new Error(created.error.message);
  libraryId = created.value.id;
  await reconcile();
  return created.value.id;
}

/** Reconcile the library, as the server does after a change or on its interval. */
async function reconcile(id = libraryId) {
  await LibraryCatalog.refreshLibrary(t.ctx, id);
  await LibraryCatalog.whenIdle();
}

const rows = (id = libraryId) =>
  t.drive.db
    .select()
    .from(libraryItems)
    .where(eq(libraryItems.libraryId, id))
    .all();
const at = (path: string, id = libraryId) =>
  t.drive.db
    .select()
    .from(libraryItems)
    .where(and(eq(libraryItems.libraryId, id), eq(libraryItems.path, path)))
    .all()
    .find((row) => row.missingSince === null);
async function listed(id = libraryId) {
  const items = await LibraryCatalog.items(
    t.ctx,
    id,
    await LibraryAccess.targetOf(t.ctx, id),
  );
  if (items.kind !== "ok") throw new Error("too large");
  return items.items.map((item) => item.path).sort();
}

test("files found by a folder's first scan are dated by their modification time, never later than now", async () => {
  await file("library/kitchen/Sourdough basics.md", "loaf");
  await file(
    "library/kitchen/Future.md",
    "later",
    new Date(t.now() + 10 * DAY),
  );
  await create();
  expect(at("library/kitchen/Sourdough basics.md")?.addedAt).toBe(
    old.getTime(),
  );
  expect(at("library/kitchen/Future.md")?.addedAt).toBe(t.now());
});

test("files that arrive later are dated when first seen, even with an old modification time", async () => {
  await create();
  t.advance(HOUR);
  await file("library/kitchen/Trail map.pdf", "map");
  await reconcile();
  expect(at("library/kitchen/Trail map.pdf")?.addedAt).toBe(t.now());
  // A folder added to the library later is first scanned then, so its files keep their dates.
  await file("library/garage/Bike repair notes.md", "chain");
  await Libraries.update(t.ctx, await t.drive.access("owner"), false, {
    id: libraryId,
    title: "Kitchen",
    folders: ["library/kitchen", "library/garage"],
    acknowledgedDevices: [],
  });
  await reconcile();
  expect(at("library/garage/Bike repair notes.md")?.addedAt).toBe(
    old.getTime(),
  );
});

test("an edit in place keeps the id and added date, with a new version", async () => {
  await file("library/kitchen/Notes.md", "first");
  await create();
  const before = at("library/kitchen/Notes.md");
  t.advance(HOUR);
  await file("library/kitchen/Notes.md", "second draft", new Date());
  await reconcile();
  const after = at("library/kitchen/Notes.md");
  expect(after?.id).toBe(before?.id ?? "");
  expect(after?.addedAt).toBe(before?.addedAt ?? -1);
  expect(after?.version).not.toBe(before?.version ?? "");
});

test("a rename outside Nimbus is a new item, and the old row a tombstone", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  await create();
  const original = at("library/kitchen/Notes.md");
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/kitchen/Guides/Proofing notes.md"),
  );
  t.advance(HOUR);
  await reconcile();
  expect(at("library/kitchen/Guides/Proofing notes.md")?.id).not.toBe(
    original?.id ?? "",
  );
  expect(await listed()).toEqual(["library/kitchen/Guides/Proofing notes.md"]);
  expect(rows().find((row) => row.id === original?.id)?.missingSince).toBe(
    t.now(),
  );
});

test("a folder that vanishes and returns gets its rows back, and nothing missing is listed", async () => {
  await file("library/kitchen/Guides/Loaf.md", "loaf");
  await file("library/kitchen/Guides/Rolls.md", "rolls");
  await create();
  const loaf = at("library/kitchen/Guides/Loaf.md");
  await rename(
    t.drive.absolute("library/kitchen/Guides"),
    t.drive.absolute("library/away"),
  );
  t.advance(HOUR);
  await reconcile();
  expect(await listed()).toEqual([]);
  expect(rows().every((row) => row.missingSince === t.now())).toBe(true);
  await rename(
    t.drive.absolute("library/away"),
    t.drive.absolute("library/kitchen/Guides"),
  );
  t.advance(HOUR);
  await reconcile();
  expect(await listed()).toEqual([
    "library/kitchen/Guides/Loaf.md",
    "library/kitchen/Guides/Rolls.md",
  ]);
  expect(at("library/kitchen/Guides/Loaf.md")?.id).toBe(loaf?.id ?? "");
  expect(rows()).toHaveLength(2);
});

test("a different file at an old path is a new item", async () => {
  await file("library/kitchen/Notes.md", "first");
  await create();
  const first = at("library/kitchen/Notes.md");
  await rm(t.drive.absolute("library/kitchen/Notes.md"));
  t.advance(HOUR);
  await reconcile();
  await file("library/kitchen/Notes.md", "something else entirely");
  t.advance(HOUR);
  await reconcile();
  expect(at("library/kitchen/Notes.md")?.id).not.toBe(first?.id ?? "");
});

test("tombstones are pruned after 30 days and beyond a bounded count", async () => {
  await file("library/kitchen/Gone.md", "gone");
  await create();
  await rm(t.drive.absolute("library/kitchen/Gone.md"));
  await reconcile();
  expect(rows()).toHaveLength(1);
  t.advance(TOMBSTONE_RETENTION_MS + 1);
  await reconcile();
  expect(rows()).toHaveLength(0);
  // The count bound keeps the most recent tombstones.
  t.drive.db
    .insert(libraryItems)
    .values(
      Array.from({ length: MAX_TOMBSTONES + 5 }, (_, index) => ({
        id: `itm_tombstone${String(index).padStart(6, "0")}`,
        libraryId,
        path: `library/kitchen/old-${index}.md`,
        addedAt: 0,
        version: "v1_aaaaaaaa",
        sizeBytes: 1,
        modifiedAt: 0,
        missingSince: t.now() - index,
      })),
    )
    .run();
  await reconcile();
  const kept = rows();
  expect(kept).toHaveLength(MAX_TOMBSTONES);
  expect(kept.map((row) => row.id)).not.toContain(
    `itm_tombstone${String(MAX_TOMBSTONES + 4).padStart(6, "0")}`,
  );
});

test("a folder swapped for a link during a scan lists nothing from where the link leads", async () => {
  await file("library/kitchen/Guides/Loaf.md", "loaf");
  await file("other/Guides/Not in the library.md", "private");
  const scanned = await LibraryCatalog.scan(["library/kitchen"], {
    beforeOpen: async (relative) => {
      if (relative !== "library/kitchen/Guides") return;
      await rename(
        t.drive.absolute("library/kitchen"),
        t.drive.absolute("library/moved"),
      );
      await symlink(
        t.drive.absolute("other"),
        t.drive.absolute("library/kitchen"),
      );
    },
  });
  expect(
    scanned.kind === "ok" && scanned.files.map((entry) => entry.path),
  ).toEqual([]);
});
