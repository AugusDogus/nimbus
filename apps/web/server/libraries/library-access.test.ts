import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { libraryItems } from "../db/library-schema";
import { DevicePairing } from "./device-pairing";
import { Libraries } from "./libraries";
import { LibraryAccess, type LibraryScope } from "./library-access";
import { LibraryCatalog } from "./library-catalog";
import { LibraryListing } from "./library-listing";
import {
  openLibraryTest,
  testOrigin,
  type LibraryTest,
} from "./library-testing";
import { PairedDevices } from "./paired-devices";

let t: LibraryTest;
beforeEach(async () => {
  t = await openLibraryTest();
  for (const file of [
    "library/kitchen/Guides/Sourdough basics.mp4",
    "library/kitchen/Bread notes.pdf",
    "library/kitchen/.hidden-notes.pdf",
    "library/kitchen/.cache/thumb.jpg",
    "library/kitchen/library.json",
    "library/kitchen-extra/Not in the library.pdf",
    "other/Trail map.pdf",
  ])
    await t.drive.write(file);
});
afterEach(() => t.close());

let paired = 0;
/** Pair a device for `account` to a new library of `folders`, returning its scope. */
async function scopeFor(
  folders: string[],
  account: "owner" | "alice" = "owner",
): Promise<{ scope: LibraryScope; token: string; libraryId: string }> {
  const created = await Libraries.create(
    t.ctx,
    await t.drive.access(account),
    false,
    { title: "Kitchen", folders },
  );
  if (!created.ok) throw new Error(created.error.message);
  const started = DevicePairing.start(
    t.ctx,
    "Media box",
    `203.0.113.${++paired}`,
  );
  if (!started.ok) throw new Error(started.error.message);
  const session = t.signIn(account);
  const shown = await DevicePairing.review(
    t.ctx,
    session,
    started.value.pairingCode,
    "203.0.113.200",
  );
  if (!shown.ok) throw new Error(shown.error.message);
  await DevicePairing.decide(
    t.ctx,
    session,
    {
      pairingId: shown.value.pairingId,
      ticket: shown.value.ticket,
      decision: { kind: "approve", libraryId: created.value.id },
    },
    "203.0.113.200",
  );
  const polled = DevicePairing.poll(
    t.ctx,
    started.value.deviceCode,
    "203.0.113.200",
  );
  if (!polled.ok || polled.value.status !== "approved")
    throw new Error("not approved");
  const scope = await current(polled.value.token);
  return { scope, token: polled.value.token, libraryId: created.value.id };
}

async function current(token: string): Promise<LibraryScope> {
  const auth = PairedDevices.authenticate(
    t.ctx,
    new Request(`${testOrigin}/api/library/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  if (!auth.ok) throw new Error(auth.error.message);
  const scope = await LibraryAccess.forDevice(t.ctx, auth.device);
  if (!scope.ok) throw new Error(scope.error.message);
  return scope.value;
}

async function listedPaths(scope: LibraryScope) {
  const listing = await LibraryListing.library(t.ctx, scope, null);
  if (!listing.ok) throw new Error(listing.error.message);
  const rows = t.drive.db.select().from(libraryItems).all();
  return listing.body.items.map(
    (item) => rows.find((row) => row.id === item.id)?.path,
  );
}

test("an administrator owner's device reads only inside the library, and only reads", async () => {
  const { scope } = await scopeFor(["library/kitchen"]);
  expect((await t.drive.access("owner")).isAdmin).toBe(true);
  expect(scope.access.isAdmin).toBe(false);
  expect(scope.access.grants).toEqual([]);
  expect(() => scope.access.requireAdmin()).toThrow();
  expect(scope.access.can("library/kitchen/Bread notes.pdf", "read")).toBe(
    true,
  );
  for (const permission of ["write", "admin"] as const)
    expect(
      scope.access.can("library/kitchen/Bread notes.pdf", permission),
    ).toBe(false);
  for (const outside of [
    "other/Trail map.pdf",
    "library",
    "",
    "library/kitchen-extra/Not in the library.pdf",
  ]) {
    expect(scope.access.can(outside, "read")).toBe(false);
    expect(scope.access.canBrowse(outside)).toBe(false);
  }
  expect((await listedPaths(scope)).sort()).toEqual([
    "library/kitchen/Bread notes.pdf",
    "library/kitchen/Guides/Sourdough basics.mp4",
  ]);
});

test("traversal and encoded paths in catalog rows reach nothing", async () => {
  const { scope, libraryId } = await scopeFor(["library/kitchen"]);
  for (const [id, path] of [
    ["itm_traversal000001", "library/kitchen/../../other/Trail map.pdf"],
    ["itm_traversal000002", "library/kitchen/%2e%2e/other/Trail map.pdf"],
    ["itm_traversal000003", "library/kitchen/..%2f..%2fother%2fTrail map.pdf"],
    ["itm_traversal000004", "/etc/passwd"],
    ["itm_traversal000005", "library/kitchen/./Bread notes.pdf"],
  ] as const)
    t.drive.db
      .insert(libraryItems)
      .values({
        id,
        libraryId,
        path,
        addedAt: 0,
        modifiedAt: 0,
        version: "v1_aaaaaaaa",
        sizeBytes: 1,
      })
      .run();
  // Paths that leave the folder, or are not written the one canonical way, never resolve.
  for (const id of [
    "itm_traversal000001",
    "itm_traversal000004",
    "itm_traversal000005",
  ])
    expect(LibraryAccess.resolve(t.ctx, scope, id).ok).toBe(false);
  // Percent signs are literal names inside the folder: nothing decodes them into a way out.
  for (const id of ["itm_traversal000002", "itm_traversal000003"])
    expect((await LibraryAccess.open(t.ctx, scope, id)).ok).toBe(false);
  for (const id of ["../itm_x", "itm_%2e%2e%2f", "itm_a/b", ""])
    expect(LibraryAccess.resolve(t.ctx, scope, id).ok).toBe(false);
});

test("symbolic links are never listed or opened", async () => {
  await symlink(
    t.drive.absolute("other/Trail map.pdf"),
    t.drive.absolute("library/kitchen/Linked map.pdf"),
  );
  await symlink(
    t.drive.absolute("other"),
    t.drive.absolute("library/kitchen/Linked folder"),
  );
  await mkdir(t.drive.absolute("library/elsewhere"), { recursive: true });
  const { scope, libraryId } = await scopeFor(["library/kitchen"]);
  expect(await listedPaths(scope)).not.toContain(
    "library/kitchen/Linked map.pdf",
  );
  expect(
    (await listedPaths(scope)).some((path) => path?.includes("Linked folder")),
  ).toBe(false);
  // A row for the link, as a swap after scanning would leave, does not open.
  t.drive.db
    .insert(libraryItems)
    .values({
      id: "itm_linkedmap000001",
      libraryId,
      path: "library/kitchen/Linked map.pdf",
      addedAt: 0,
      modifiedAt: 0,
      version: "v1_aaaaaaaa",
      sizeBytes: 1,
    })
    .run();
  expect(LibraryAccess.resolve(t.ctx, scope, "itm_linkedmap000001").ok).toBe(
    true,
  );
  expect(
    (await LibraryAccess.open(t.ctx, scope, "itm_linkedmap000001")).ok,
  ).toBe(false);
});

test("a library folder replaced by a symbolic link contributes nothing", async () => {
  const { scope, token } = await scopeFor(["library/kitchen"]);
  expect(await listedPaths(scope)).toHaveLength(2);
  await Bun.$`mv ${t.drive.absolute("library/kitchen")} ${t.drive.absolute("library/moved")}`.quiet();
  await symlink(t.drive.absolute("other"), t.drive.absolute("library/kitchen"));
  LibraryCatalog.resetForTest();
  expect(await listedPaths(await current(token))).toEqual([]);
});

test("an item opens as a regular file, and only through its own library", async () => {
  const { scope } = await scopeFor(["library/kitchen"]);
  const listing = await LibraryListing.library(t.ctx, scope, null);
  if (!listing.ok) throw new Error(listing.error.message);
  const bread = listing.body.items.find(
    (item) => item.name === "Bread notes.pdf",
  );
  if (!bread) throw new Error("not listed");
  const opened = await LibraryAccess.open(t.ctx, scope, bread.id);
  expect(opened.ok).toBe(true);
  if (opened.ok) await opened.value.opened.handle.close();
  // Another library's device cannot use this id, even for the same folder.
  const other = await scopeFor(["library/kitchen"]);
  expect(LibraryAccess.resolve(t.ctx, other.scope, bread.id).ok).toBe(false);
});

test("a folder removed from the library stops serving at once", async () => {
  const { scope, token, libraryId } = await scopeFor([
    "library/kitchen",
    "other",
  ]);
  expect(await listedPaths(scope)).toContain("other/Trail map.pdf");
  const updated = await Libraries.update(
    t.ctx,
    await t.drive.access("owner"),
    false,
    {
      id: libraryId,
      title: "Kitchen",
      folders: ["library/kitchen"],
      acknowledgedDevices: [],
    },
  );
  expect(updated.ok).toBe(true);
  const after = await current(token);
  expect(await listedPaths(after)).not.toContain("other/Trail map.pdf");
  const [row] = t.drive.db
    .select()
    .from(libraryItems)
    .where(eq(libraryItems.path, "other/Trail map.pdf"))
    .all();
  if (row) expect(LibraryAccess.resolve(t.ctx, after, row.id).ok).toBe(false);
});

test("a revoked device has no scope", async () => {
  const { token } = await scopeFor(["library/kitchen"]);
  await PairedDevices.revokeForUser(t.ctx, "owner", "password_changed");
  expect(current(token)).rejects.toThrow("disconnected");
});

test("an owner who loses sharing or read access loses it for the device too", async () => {
  await t.drive.write("library/maps/Ridge map.pdf");
  const grant = await t.drive.grant("library/maps", "alice", "admin");
  const { scope, token } = await scopeFor(["library/maps"], "alice");
  expect(await listedPaths(scope)).toEqual(["library/maps/Ridge map.pdf"]);
  // Read alone is not enough to keep handing a folder to a device, as for public links.
  await t.drive.store.removeGrant(grant.id);
  await t.drive.grant("library/maps", "alice", "read");
  const readOnly = await current(token);
  expect(readOnly.folders).toEqual([]);
  expect(LibraryAccess.reaches(readOnly, "library/maps/Ridge map.pdf")).toBe(
    false,
  );
  const listing = await LibraryListing.library(t.ctx, readOnly, null);
  expect(!listing.ok && listing.error.code).toBe("library_unavailable");
});

test("hidden files and the data file are never items", async () => {
  const { scope } = await scopeFor(["library/kitchen"]);
  for (const path of [
    "library/kitchen/.hidden-notes.pdf",
    "library/kitchen/.cache/thumb.jpg",
    "library/kitchen/library.json",
  ])
    expect(LibraryAccess.reaches(scope, path)).toBe(false);
  // A library.json elsewhere is an ordinary file.
  await t.drive.write("library/kitchen/Guides/library.json");
  LibraryCatalog.resetForTest();
  expect(
    await listedPaths(
      await current((await scopeFor(["library/kitchen"])).token),
    ),
  ).toContain("library/kitchen/Guides/library.json");
});

test("the data file is read through the scope, bounded, and only as a regular file", async () => {
  await writeFile(
    t.drive.absolute("library/kitchen/library.json"),
    '{"version":1}',
  );
  const { scope, token } = await scopeFor(["library/kitchen", "other"]);
  const read = await LibraryAccess.readData(scope);
  expect(read.ok && new TextDecoder().decode(read.value)).toBe('{"version":1}');
  await writeFile(
    t.drive.absolute("library/kitchen/library.json"),
    "x".repeat(64 * 1024 + 1),
  );
  const large = await LibraryAccess.readData(await current(token));
  expect(!large.ok && large.error.code).toBe("library_data_too_large");
  await Bun.$`rm ${t.drive.absolute("library/kitchen/library.json")}`.quiet();
  await symlink(
    t.drive.absolute("other/Trail map.pdf"),
    t.drive.absolute("library/kitchen/library.json"),
  );
  const linked = await LibraryAccess.readData(await current(token));
  expect(!linked.ok && linked.error.code).toBe("library_data_not_found");
});

test("a device never sees into a home container set up after its library", async () => {
  const { token } = await scopeFor(["library/kitchen"]);
  // Configuration changed since: homes now live inside the library's folder.
  await t.drive.store.addHomeContainer("library/kitchen/homes");
  await t.drive.write("library/kitchen/homes/bob/Private.md");
  await t.drive.store.createHome(
    { userId: "bob", path: "library/kitchen/homes/bob" },
    {
      id: "home-bob",
      path: "library/kitchen/homes/bob",
      subject: { type: "user", id: "bob" },
      permission: "admin",
    },
  );
  LibraryCatalog.resetForTest();
  const scope = await current(token);
  expect(scope.folders).toEqual([]);
  expect(
    LibraryAccess.reaches(scope, "library/kitchen/homes/bob/Private.md"),
  ).toBe(false);
});
