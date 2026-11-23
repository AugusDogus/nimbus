import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { Homes } from "@nimbus/api/homes";
import { Libraries } from "./libraries";
import { openLibraryTest, type LibraryTest } from "./library-testing";

let t: LibraryTest;
beforeEach(async () => {
  t = await openLibraryTest();
  for (const folder of [
    "library/kitchen",
    "library/garage",
    "homes/alice",
    "homes/bob",
  ])
    await mkdir(t.drive.absolute(folder), { recursive: true });
  await t.drive.write("library/notes.pdf");
  await t.drive.store.addHomeContainer("homes");
  await t.drive.store.createHome(
    { userId: "alice", path: "homes/alice" },
    {
      id: "home-alice",
      path: "homes/alice",
      subject: { type: "user", id: "alice" },
      permission: "admin",
    },
  );
  await t.drive.store.createHome(
    { userId: "bob", path: "homes/bob" },
    {
      id: "home-bob",
      path: "homes/bob",
      subject: { type: "user", id: "bob" },
      permission: "admin",
    },
  );
});
afterEach(() => t.close());

const create = async (
  folders: string[],
  account: "owner" | "alice" = "owner",
  impersonated = false,
) =>
  Libraries.create(t.ctx, await t.drive.access(account), impersonated, {
    title: "Kitchen",
    folders,
  });

test("folders keep the owner's order", async () => {
  const created = await create(["library/kitchen", "library/garage"]);
  if (!created.ok) throw new Error(created.error.message);
  expect(Libraries.folders(t.ctx, created.value.id)).toEqual([
    "library/kitchen",
    "library/garage",
  ]);
});

test.each([
  [[""], "forbidden"],
  [["homes"], "forbidden"],
  [["homes/bob"], "forbidden"],
  [["library/notes.pdf"], "invalid"],
  [["library/missing"], "not_found"],
  [["../outside"], "invalid"],
  [["library/.nimbus"], "forbidden"],
  [[], "invalid"],
] as const)("an owner cannot add %p (%s)", async (folders, kind) => {
  const created = await create([...folders]);
  expect(!created.ok && created.error.kind).toBe(kind);
});

test("an account adds only folders it may share, and its own home", async () => {
  expect((await create(["homes/alice"], "alice")).ok).toBe(true);
  expect((await create(["library/kitchen"], "alice")).ok).toBe(false);
  await t.drive.grant("library/kitchen", "alice", "read");
  expect((await create(["library/kitchen"], "alice")).ok).toBe(false);
  await t.drive.grant("library/kitchen", "alice", "admin");
  expect((await create(["library/kitchen"], "alice")).ok).toBe(true);
});

test("libraries cannot be changed while impersonating", async () => {
  const created = await create(["homes/alice"], "alice", true);
  expect(!created.ok && created.error.kind).toBe("forbidden");
});

test("titles are 1 to 120 characters without controls", async () => {
  const access = await t.drive.access("owner");
  for (const title of ["", "  ", "x".repeat(121), "Tab\tbed"])
    expect(
      (
        await Libraries.create(t.ctx, access, false, {
          title,
          folders: ["library/kitchen"],
        })
      ).ok,
    ).toBe(false);
});

test("another account's home is refused under any spelling storage treats as the same", async () => {
  await mkdir(t.drive.absolute("homes/BOB"), { recursive: true });
  const created = await create(["homes/BOB"]);
  expect(!created.ok && created.error.kind).toBe("forbidden");
});

test("a home container is not set up beneath a library folder", async () => {
  await mkdir(t.drive.absolute("library/kitchen"), { recursive: true });
  expect((await create(["library/kitchen"])).ok).toBe(true);
  const prepared = await Homes.prepare(t.drive.store, "library/kitchen/homes");
  expect(prepared.kind).toBe("refused");
});
