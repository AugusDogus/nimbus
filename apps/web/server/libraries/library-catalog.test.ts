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

test("a rename outside Nimbus keeps the id and added date", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  await create();
  const original = at("library/kitchen/Notes.md");
  t.advance(HOUR);
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/kitchen/Proofing notes.md"),
  );
  await reconcile();
  const renamed = at("library/kitchen/Proofing notes.md");
  expect(renamed?.id).toBe(original?.id ?? "");
  expect(renamed?.addedAt).toBe(original?.addedAt ?? -1);
  // A rename changes the file's change time, so its version, and so its poster, is new.
  expect(renamed?.version).not.toBe(original?.version ?? "");
  expect(await listed()).toEqual(["library/kitchen/Proofing notes.md"]);
  expect(rows()).toHaveLength(1);
});

test("a move to another folder of the same library keeps the id", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  const id = await create(["library/kitchen", "library/garage"]);
  const original = at("library/kitchen/Notes.md");
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/garage/Notes.md"),
  );
  await reconcile(id);
  expect(at("library/garage/Notes.md")?.id).toBe(original?.id ?? "");
  expect(rows()).toHaveLength(1);
});

test("a rename seen across two reconciles keeps the id", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  await create();
  const original = at("library/kitchen/Notes.md");
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/away.md"),
  );
  t.advance(HOUR);
  await reconcile();
  expect(await listed()).toEqual([]);
  await rename(
    t.drive.absolute("library/away.md"),
    t.drive.absolute("library/kitchen/Guides/Proofing notes.md"),
  );
  t.advance(HOUR);
  await reconcile();
  expect(at("library/kitchen/Guides/Proofing notes.md")?.id).toBe(
    original?.id ?? "",
  );
  expect(rows()).toHaveLength(1);
});

test("two new files with the same size and time as a vanished one are new items", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  await create();
  const original = at("library/kitchen/Notes.md");
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/kitchen/Copy one.md"),
  );
  await file("library/kitchen/Copy two.md", "proofing times");
  await reconcile();
  expect(at("library/kitchen/Copy one.md")?.id).not.toBe(original?.id ?? "");
  expect(at("library/kitchen/Copy two.md")?.id).not.toBe(original?.id ?? "");
  expect(rows().find((row) => row.id === original?.id)?.missingSince).toBe(
    t.now(),
  );
});

test("a new file matching two vanished ones by size and time is a new item", async () => {
  await file("library/kitchen/First.md", "proofing times");
  await file("library/kitchen/Second.md", "proofing times");
  await create();
  const before = rows().map((row) => row.id);
  await rm(t.drive.absolute("library/kitchen/Second.md"));
  await rename(
    t.drive.absolute("library/kitchen/First.md"),
    t.drive.absolute("library/kitchen/Third.md"),
  );
  await reconcile();
  expect(before).not.toContain(at("library/kitchen/Third.md")?.id ?? "");
  expect(rows()).toHaveLength(3);
});

test("an empty file renamed outside Nimbus is a new item", async () => {
  await file("library/kitchen/Empty.md", "");
  await create();
  const original = at("library/kitchen/Empty.md");
  await rename(
    t.drive.absolute("library/kitchen/Empty.md"),
    t.drive.absolute("library/kitchen/Still empty.md"),
  );
  await reconcile();
  expect(at("library/kitchen/Still empty.md")?.id).not.toBe(original?.id ?? "");
});

test("a file moved into another library is a new item there", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  const kitchen = await create(["library/kitchen"]);
  const original = at("library/kitchen/Notes.md", kitchen);
  const garage = await create(["library/garage"]);
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/garage/Notes.md"),
  );
  await reconcile(kitchen);
  await reconcile(garage);
  expect(at("library/garage/Notes.md", garage)?.id).not.toBe(
    original?.id ?? "",
  );
  expect(
    rows(kitchen).find((row) => row.id === original?.id)?.missingSince,
  ).toBe(t.now());
});

test("no match is made out of or into a folder outside the visible set", async () => {
  await file("library/garage/Chain.md", "chain lube");
  await file("library/kitchen/Notes.md", "proofing times");
  const id = await create(["library/kitchen", "library/garage"]);
  const chain = at("library/garage/Chain.md", id);
  const notes = at("library/kitchen/Notes.md", id);
  const narrow = { folders: ["library/kitchen"] };
  // The garage stops being visible as its file moves into the kitchen, and a kitchen file
  // moves into the garage.
  await rename(
    t.drive.absolute("library/garage/Chain.md"),
    t.drive.absolute("library/kitchen/Chain.md"),
  );
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/garage/Notes.md"),
  );
  LibraryCatalog.resetForTest();
  const items = await LibraryCatalog.items(t.ctx, id, narrow);
  expect(items.kind === "ok" && items.items.map((item) => item.path)).toEqual([
    "library/kitchen/Chain.md",
  ]);
  expect(at("library/kitchen/Chain.md", id)?.id).not.toBe(chain?.id ?? "");
  expect(at("library/garage/Notes.md", id)).toBeUndefined();
  expect(rows(id).find((row) => row.id === notes?.id)?.missingSince).toBe(
    t.now(),
  );
});

test("a file moved after its tombstone expired is a new item", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  await create();
  const original = at("library/kitchen/Notes.md");
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/away.md"),
  );
  await reconcile();
  t.advance(TOMBSTONE_RETENTION_MS + DAY);
  await rename(
    t.drive.absolute("library/away.md"),
    t.drive.absolute("library/kitchen/Guides/Notes.md"),
  );
  await reconcile();
  expect(at("library/kitchen/Guides/Notes.md")?.id).not.toBe(
    original?.id ?? "",
  );
  expect(rows()).toHaveLength(1);
});

test("a moved file keeps its id while a different file at the old path is new", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  await create();
  const original = at("library/kitchen/Notes.md");
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/away.md"),
  );
  await reconcile();
  await file("library/kitchen/Notes.md", "a different recipe");
  await rename(
    t.drive.absolute("library/away.md"),
    t.drive.absolute("library/kitchen/Guides/Notes.md"),
  );
  await reconcile();
  expect(at("library/kitchen/Guides/Notes.md")?.id).toBe(original?.id ?? "");
  expect(at("library/kitchen/Notes.md")?.id).not.toBe(original?.id ?? "");
  expect(rows()).toHaveLength(2);
});

test("a file returning to its old path wins over a copy elsewhere", async () => {
  await file("library/kitchen/Notes.md", "proofing times");
  await create();
  const original = at("library/kitchen/Notes.md");
  await rename(
    t.drive.absolute("library/kitchen/Notes.md"),
    t.drive.absolute("library/away.md"),
  );
  await reconcile();
  await rename(
    t.drive.absolute("library/away.md"),
    t.drive.absolute("library/kitchen/Notes.md"),
  );
  await file("library/kitchen/Guides/Notes copy.md", "proofing times");
  await reconcile();
  expect(at("library/kitchen/Notes.md")?.id).toBe(original?.id ?? "");
  expect(at("library/kitchen/Guides/Notes copy.md")?.id).not.toBe(
    original?.id ?? "",
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

test("a scan for one set of visible folders is never handed to another", async () => {
  await file("library/kitchen/Loaf.md", "loaf");
  for (let index = 0; index < 2001; index++)
    await file(`library/garage/bulk/${index}.md`, "x");
  const id = await create(["library/kitchen", "library/garage"]);
  LibraryCatalog.resetForTest();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const restore = LibraryCatalog.useScanHooksForTest({
    beforeOpen: async (relative) => {
      if (relative === "library/garage") await held;
    },
  });
  try {
    const wide = LibraryCatalog.items(t.ctx, id, {
      folders: ["library/kitchen", "library/garage"],
    });
    // The garage stops being visible while the wider scan is under way.
    const narrow = LibraryCatalog.items(t.ctx, id, {
      folders: ["library/kitchen"],
    });
    release();
    expect((await wide).kind).toBe("too_large");
    const result = await narrow;
    expect(
      result.kind === "ok" && result.items.map((item) => item.path),
    ).toEqual(["library/kitchen/Loaf.md"]);
  } finally {
    restore();
  }
});

test("a change during a scan is not lost when the scan finishes", async () => {
  await file("library/kitchen/Guides/Loaf.md", "loaf");
  const id = await create(["library/kitchen"]);
  LibraryCatalog.resetForTest();
  const target = { folders: ["library/kitchen"] };
  const restore = LibraryCatalog.useScanHooksForTest({
    beforeOpen: async (relative) => {
      if (relative !== "library/kitchen/Guides") return;
      // The top folder was already read: this file arrives behind the scan.
      await file("library/kitchen/Late.md", "late");
      LibraryCatalog.noteChange(t.ctx, "library/kitchen/Late.md");
    },
  });
  try {
    await LibraryCatalog.items(t.ctx, id, target);
  } finally {
    restore();
  }
  const again = await LibraryCatalog.items(t.ctx, id, target);
  expect(
    again.kind === "ok" && again.items.map((item) => item.path).sort(),
  ).toEqual(["library/kitchen/Guides/Loaf.md", "library/kitchen/Late.md"]);
});

test("a folder moved out of the library while it is read contributes nothing", async () => {
  await file("library/kitchen/Guides/Loaf.md", "loaf");
  const scanned = await LibraryCatalog.scan(["library/kitchen"], {
    afterOpen: async (relative) => {
      if (relative !== "library/kitchen/Guides") return;
      await mkdir(t.drive.absolute("other"), { recursive: true });
      await rename(
        t.drive.absolute("library/kitchen/Guides"),
        t.drive.absolute("other/Elsewhere"),
      );
      await file("other/Elsewhere/Not in the library.md", "private");
    },
  });
  expect(
    scanned.kind === "ok" && scanned.files.map((entry) => entry.path),
  ).toEqual([]);
});

test("renaming a library does not make its folders count as never scanned", async () => {
  await create();
  await Libraries.update(t.ctx, await t.drive.access("owner"), false, {
    id: libraryId,
    title: "Kitchen and pantry",
    folders: ["library/kitchen"],
    acknowledgedDevices: [],
  });
  t.advance(HOUR);
  await file("library/kitchen/Arrived later.md", "new");
  await reconcile();
  expect(at("library/kitchen/Arrived later.md")?.addedAt).toBe(t.now());
});

test("a file returning after its tombstone expired is a new item", async () => {
  await file("library/kitchen/Notes.md", "notes");
  await create();
  const first = at("library/kitchen/Notes.md");
  await rm(t.drive.absolute("library/kitchen/Notes.md"));
  await reconcile();
  // No scan for longer than tombstones are kept, then the same file is back.
  t.advance(TOMBSTONE_RETENTION_MS + DAY);
  await file("library/kitchen/Notes.md", "notes");
  await reconcile();
  expect(at("library/kitchen/Notes.md")?.id).not.toBe(first?.id ?? "");
  expect(rows()).toHaveLength(1);
});

test("the tombstone limit counts the files that vanished in the same pass", async () => {
  for (let index = 0; index < 20; index++)
    await file(`library/kitchen/Batch/${index}.md`, `${index}`);
  await create();
  t.drive.db
    .insert(libraryItems)
    .values(
      Array.from({ length: MAX_TOMBSTONES - 10 }, (_, index) => ({
        id: `itm_oldtombstone${String(index).padStart(6, "0")}`,
        libraryId,
        path: `library/kitchen/old-${index}.md`,
        addedAt: 0,
        version: "v1_aaaaaaaa",
        sizeBytes: 1,
        modifiedAt: 0,
        missingSince: t.now() - 1000 - index,
      })),
    )
    .run();
  await rm(t.drive.absolute("library/kitchen/Batch"), { recursive: true });
  await reconcile();
  expect(rows().filter((row) => row.missingSince !== null)).toHaveLength(
    MAX_TOMBSTONES,
  );
  // The newest are kept.
  expect(rows().filter((row) => row.missingSince === t.now())).toHaveLength(20);
});

test("a reconcile writes in one transaction, however many files changed", async () => {
  for (let index = 0; index < 50; index++)
    await file(`library/kitchen/Batch/${index}.md`, `${index}`);
  await create();
  await rm(t.drive.absolute("library/kitchen/Batch/0.md"));
  for (let index = 50; index < 80; index++)
    await file(`library/kitchen/Batch/${index}.md`, `${index}`);
  await writeFile(t.drive.absolute("library/kitchen/Batch/1.md"), "edited");
  let transactions = 0;
  const db = new Proxy(t.ctx.db, {
    get(target, property, receiver) {
      if (property === "transaction") transactions += 1;
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  LibraryCatalog.resetForTest();
  await LibraryCatalog.refreshLibrary({ ...t.ctx, db }, libraryId);
  expect(transactions).toBe(1);
  expect(rows().filter((row) => row.missingSince === null)).toHaveLength(79);
});
