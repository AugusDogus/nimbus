import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { JSONSchema } from "zod/v4/core";
import { DevicePairing } from "./device-pairing";
import { Libraries } from "./libraries";
import { LibraryCatalog } from "./library-catalog";
import { LibraryHttp } from "./library-http";
import {
  openLibraryTest,
  testOrigin,
  type LibraryTest,
} from "./library-testing";
import { PairedDevices } from "./paired-devices";

/**
 * The library API as a client sees it, through the same handler the server routes
 * /api/library/v1/* to, with responses checked against docs/library-api/openapi.yaml.
 */

const contractFile = fileURLToPath(
  new URL("../../../../docs/library-api/openapi.yaml", import.meta.url),
);
const contractShape = z.object({
  components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
});
const definitions: unknown = JSON.parse(
  JSON.stringify(
    contractShape.parse(Bun.YAML.parse(await Bun.file(contractFile).text()))
      .components.schemas,
  ).replaceAll("#/components/schemas/", "#/$defs/"),
);
/** Whether `value` maps names to schemas: objects, as every schema in the contract is. */
const isSchemaMap = (
  value: unknown,
): value is Record<string, JSONSchema.JSONSchema> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(
    (schema) => typeof schema === "object" && schema !== null,
  );
if (!isSchemaMap(definitions)) throw new Error("The contract has no schemas.");
/** The contract's schema `name`, as a parser. */
const contract = (name: string) =>
  z.fromJSONSchema({ $ref: `#/$defs/${name}`, $defs: definitions });

let t: LibraryTest;
let libraryId: string;
beforeEach(async () => {
  t = await openLibraryTest();
  for (const file of [
    "library/kitchen/Guides/01 Sourdough basics.mp4",
    "library/kitchen/Guides/Bread timeline.pdf",
    "library/kitchen/Maps/Trail map.pdf",
    "library/kitchen/Ridge photo.jpg",
    "library/kitchen/.hidden.pdf",
    "library/garage/Bike repair notes.pdf",
    "other/Not shared.pdf",
  ])
    await t.drive.write(file);
  const created = await Libraries.create(
    t.ctx,
    await t.drive.access("owner"),
    false,
    { title: "Kitchen", folders: ["library/kitchen"] },
  );
  if (!created.ok) throw new Error(created.error.message);
  libraryId = created.value.id;
});
afterEach(() => t.close());

const call = (
  endpoint: string,
  init: RequestInit & { token?: string; query?: string } = {},
) => {
  const { token, query, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (rest.body !== undefined) headers.set("content-type", "application/json");
  headers.set("x-nimbus-client-ip", "192.0.2.50");
  return LibraryHttp.handle(
    t.ctx,
    new Request(
      `${testOrigin}/api/library/v1/${endpoint}${query ? `?${query}` : ""}`,
      { ...rest, headers },
    ),
    endpoint,
  );
};
const post = (endpoint: string, body: unknown) =>
  call(endpoint, { method: "POST", body: JSON.stringify(body) });

async function json(response: Response, schema: string) {
  expect(response.headers.get("cache-control")).toStartWith("private, no-");
  const body: unknown = await response.json();
  const checked = contract(schema).safeParse(body);
  if (!checked.success)
    throw new Error(
      `${schema} does not match the contract: ${JSON.stringify(checked.error.issues)} in ${JSON.stringify(body)}`,
    );
  return body;
}

const pollBody = z.object({
  status: z.literal("approved"),
  token: z.string(),
  library: z.object({ id: z.string(), title: z.string() }),
});
const startBody = z.object({ deviceCode: z.string(), pairingCode: z.string() });
const libraryBody = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      folder: z.number(),
      path: z.string(),
      addedAt: z.string(),
    }),
  ),
  generatedAt: z.string(),
});

/** Pair "Media box" with the library through the real endpoints and the pairing page's steps. */
async function pair(library = libraryId, account: "owner" | "alice" = "owner") {
  const started = startBody.parse(
    await json(
      await post("pair/start", { deviceName: "Media box" }),
      "PairStartResponse",
    ),
  );
  expect(
    await json(
      await post("pair/poll", { deviceCode: started.deviceCode }),
      "PairPollResponse",
    ),
  ).toEqual({ status: "pending" });
  const session = t.signIn(account);
  const shown = await DevicePairing.review(
    t.ctx,
    session,
    started.pairingCode,
    "192.0.2.50",
  );
  if (!shown.ok) throw new Error(shown.error.message);
  const decided = await DevicePairing.decide(
    t.ctx,
    session,
    {
      pairingId: shown.value.pairingId,
      ticket: shown.value.ticket,
      decision: { kind: "approve", libraryId: library },
    },
    "192.0.2.50",
  );
  expect(decided.ok).toBe(true);
  t.advance(5000);
  const approved = pollBody.parse(
    await json(
      await post("pair/poll", { deviceCode: started.deviceCode }),
      "PairPollResponse",
    ),
  );
  return { ...approved, deviceCode: started.deviceCode };
}

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = z
    .object({ error: z.object({ code: z.string() }) })
    .parse(await json(response, "Error"));
  expect(body.error.code).toBe(code);
}

describe("pairing", () => {
  test("pairs, lists, revokes and then refuses the token", async () => {
    const { token, library, deviceCode } = await pair();
    expect(library).toEqual({ id: libraryId, title: "Kitchen" });
    // A second poll of the collected code gets nothing.
    t.advance(5000);
    expect(
      await json(await post("pair/poll", { deviceCode }), "PairPollResponse"),
    ).toEqual({
      status: "expired",
    });
    expect(await json(await call("me", { token }), "Me")).toEqual({
      deviceName: "Media box",
      library: { id: libraryId, title: "Kitchen" },
    });
    const listed = libraryBody.parse(
      await json(await call("library", { token }), "LibraryResponse"),
    );
    expect(listed.items.map((item) => item.name).sort()).toEqual([
      "01 Sourdough basics.mp4",
      "Bread timeline.pdf",
      "Ridge photo.jpg",
      "Trail map.pdf",
    ]);
    const devices = PairedDevices.list(t.ctx, "owner");
    expect(devices.map((device) => device.name)).toEqual(["Media box"]);
    const [device] = devices;
    if (!device) throw new Error("not listed");
    expect(
      PairedDevices.revoke(
        t.ctx,
        { id: "owner", email: "owner@example.test" },
        device.id,
      ),
    ).toBe(true);
    await error(await call("library", { token }), 401, "token_revoked");
    await error(await call("me", { token }), 401, "token_revoked");
  });

  test("an early poll slows down and an unknown code looks expired", async () => {
    const started = startBody.parse(
      await json(
        await post("pair/start", { deviceName: "Kitchen tablet" }),
        "PairStartResponse",
      ),
    );
    await post("pair/poll", { deviceCode: started.deviceCode });
    const early = await post("pair/poll", { deviceCode: started.deviceCode });
    expect(early.headers.get("retry-after")).toBe("10");
    expect(await json(early, "Error")).toMatchObject({
      error: { code: "slow_down" },
      interval: 10,
    });
    expect(
      await json(
        await post("pair/poll", { deviceCode: "nimbus_pairing_unknown" }),
        "PairPollResponse",
      ),
    ).toEqual({ status: "expired" });
  });

  test("bad requests are refused with stable codes", async () => {
    await error(
      await post("pair/start", { deviceName: "" }),
      400,
      "invalid_request",
    );
    await error(
      await post("pair/start", { deviceName: "Media box", library: "x" }),
      400,
      "invalid_request",
    );
    await error(
      await call("pair/start", { method: "POST", body: "not json" }),
      400,
      "invalid_request",
    );
    await error(
      await call("pair/start", {
        method: "POST",
        body: JSON.stringify({ deviceName: "x".repeat(5000) }),
      }),
      400,
      "invalid_request",
    );
    await error(await call("pair/start"), 405, "method_not_allowed");
    await error(await call("nowhere"), 404, "not_found");
    await error(
      await call("me", {
        headers: { origin: "https://elsewhere.example.test" },
      }),
      403,
      "forbidden_origin",
    );
  });
});

describe("authorization", () => {
  test("every endpoint but pairing needs the bearer token", async () => {
    for (const endpoint of ["me", "library"]) {
      await error(await call(endpoint), 401, "authorization_required");
      await error(
        await call(endpoint, { token: "nimbus_device_unknown" }),
        401,
        "token_invalid",
      );
      await error(
        await call(endpoint, { token: "nimbus_mcp_access_something" }),
        401,
        "token_invalid",
      );
    }
  });
});

describe("library", () => {
  test("lists newest first with names, kinds, paths and an ETag", async () => {
    const { token } = await pair();
    expect((await call("library", { token })).status).toBe(200);
    t.advance(60_000);
    await t.drive.write("library/kitchen/Guides/02_Shaping a loaf.mp4");
    LibraryCatalog.noteChange(
      t.ctx,
      t.drive.absolute("library/kitchen/Guides"),
    );
    const response = await call("library", { token });
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    const etag = response.headers.get("etag");
    const listed = libraryBody.parse(await json(response, "LibraryResponse"));
    const [newest] = listed.items;
    expect(newest).toMatchObject({
      name: "02_Shaping a loaf.mp4",
      kind: "video",
      folder: 0,
      path: "Guides/02_Shaping a loaf.mp4",
    });
    expect(
      listed.items.find((item) => item.name === "Ridge photo.jpg"),
    ).toMatchObject({
      kind: "image",
      folder: 0,
      path: "Ridge photo.jpg",
    });
    const notModified = await call("library", {
      token,
      headers: { "if-none-match": etag ?? "" },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    const documents = libraryBody.parse(
      await json(
        await call("library", { token, query: "kinds=document" }),
        "LibraryResponse",
      ),
    );
    expect(documents.items.map((item) => item.kind)).toEqual([
      "document",
      "document",
    ]);
    await error(
      await call("library", { token, query: "kinds=videos" }),
      400,
      "invalid_request",
    );
  });

  test("ids and added dates survive restarts and Nimbus's own renames", async () => {
    const { token } = await pair();
    const first = libraryBody.parse(
      await (await call("library", { token })).json(),
    );
    const map = first.items.find((item) => item.name === "Trail map.pdf");
    if (!map) throw new Error("not listed");
    t.advance(60_000);
    LibraryCatalog.resetForTest();
    const again = libraryBody.parse(
      await (await call("library", { token })).json(),
    );
    expect(again.items.find((item) => item.id === map.id)?.addedAt).toBe(
      map.addedAt,
    );
    // A move through Nimbus carries the row.
    await rename(
      t.drive.absolute("library/kitchen/Maps/Trail map.pdf"),
      t.drive.absolute("library/kitchen/Maps/North trail map.pdf"),
    );
    await t.drive.store.movePath(
      "library/kitchen/Maps/Trail map.pdf",
      "library/kitchen/Maps/North trail map.pdf",
    );
    LibraryCatalog.resetForTest();
    const moved = libraryBody.parse(
      await (await call("library", { token })).json(),
    );
    expect(
      moved.items.find((item) => item.name === "North trail map.pdf"),
    ).toMatchObject({
      id: map.id,
      addedAt: map.addedAt,
    });
    // A rename outside Nimbus is, for now, a new item.
    await rename(
      t.drive.absolute("library/kitchen/Maps/North trail map.pdf"),
      t.drive.absolute("library/kitchen/Maps/South trail map.pdf"),
    );
    LibraryCatalog.resetForTest();
    const external = libraryBody.parse(
      await (await call("library", { token })).json(),
    );
    const south = external.items.find(
      (item) => item.name === "South trail map.pdf",
    );
    expect(south?.id).not.toBe(map.id);
    expect(external.items.map((item) => item.id)).not.toContain(map.id);
  });

  test("a library of missing folders is an empty list, not a failure", async () => {
    const { token } = await pair();
    await rename(
      t.drive.absolute("library/kitchen"),
      t.drive.absolute("library/away"),
    );
    LibraryCatalog.resetForTest();
    const listed = libraryBody.parse(
      await json(await call("library", { token }), "LibraryResponse"),
    );
    expect(listed.items).toEqual([]);
    await rename(
      t.drive.absolute("library/away"),
      t.drive.absolute("library/kitchen"),
    );
    LibraryCatalog.resetForTest();
    expect(
      libraryBody.parse(await (await call("library", { token })).json()).items,
    ).toHaveLength(4);
  });

  test("another library's items are not this device's", async () => {
    const garage = await Libraries.create(
      t.ctx,
      await t.drive.access("owner"),
      false,
      {
        title: "Garage",
        folders: ["library/garage"],
      },
    );
    if (!garage.ok) throw new Error(garage.error.message);
    const kitchen = await pair();
    const other = await pair(garage.value.id);
    const garageItems = libraryBody.parse(
      await (await call("library", { token: other.token })).json(),
    ).items;
    const kitchenItems = libraryBody.parse(
      await (await call("library", { token: kitchen.token })).json(),
    ).items;
    expect(garageItems.map((item) => item.name)).toEqual([
      "Bike repair notes.pdf",
    ]);
    for (const item of garageItems)
      expect(kitchenItems.map((entry) => entry.id)).not.toContain(item.id);
  });
});

test.each([
  ["pair-start.json", "PairStartResponse"],
  ["pair-poll-approved.json", "PairPollResponse"],
  ["me.json", "Me"],
  ["library-response.json", "LibraryResponse"],
  ["error-slow-down.json", "Error"],
])("the documented fixture %s matches %s", async (file, schema) => {
  const fixture: unknown = await Bun.file(
    fileURLToPath(
      new URL(`../../../../docs/library-api/fixtures/${file}`, import.meta.url),
    ),
  ).json();
  expect(contract(schema).safeParse(fixture).success).toBe(true);
});

test("a folder its owner can no longer share reveals nothing, not even that it changed", async () => {
  await t.drive.write("library/maps/Ridge map.pdf");
  await t.drive.grant("library/maps", "alice", "admin");
  const garage = await t.drive.grant("library/garage", "alice", "admin");
  const created = await Libraries.create(
    t.ctx,
    await t.drive.access("alice"),
    false,
    { title: "Maps", folders: ["library/maps", "library/garage"] },
  );
  if (!created.ok) throw new Error(created.error.message);
  const { token } = await pair(created.value.id, "alice");
  await t.drive.store.removeGrant(garage.id);
  LibraryCatalog.resetForTest();
  const before = await call("library", { token });
  const etag = before.headers.get("etag") ?? "";
  expect(
    libraryBody.parse(await before.json()).items.map((item) => item.name),
  ).toEqual(["Ridge map.pdf"]);
  // Changes, even past the size limit, inside the folder no longer shared.
  t.advance(60_000);
  for (let index = 0; index < 2001; index++)
    await t.drive.write(`library/garage/bulk/${index}.txt`);
  LibraryCatalog.resetForTest();
  for (const query of [undefined, "kinds=document"]) {
    const after = await call("library", {
      token,
      query,
      headers: query ? {} : { "if-none-match": etag },
    });
    expect(after.status).toBe(query ? 200 : 304);
  }
});

test("only successful requests keep a device paired", async () => {
  const garage = await t.drive.grant("library/garage", "alice", "admin");
  const created = await Libraries.create(
    t.ctx,
    await t.drive.access("alice"),
    false,
    { title: "Garage", folders: ["library/garage"] },
  );
  if (!created.ok) throw new Error(created.error.message);
  const { token } = await pair(created.value.id, "alice");
  await t.drive.store.removeGrant(garage.id);
  const day = 24 * 60 * 60 * 1000;
  t.advance(29 * day);
  // Its only folder can no longer be shared: an authorized request, but not a successful one.
  expect((await call("library", { token })).status).toBe(503);
  t.advance(2 * day);
  await error(await call("me", { token }), 401, "token_revoked");
});

describe("revocation while a request is in flight", () => {
  const owner = { id: "owner", email: "owner@example.test" };

  test("a request answered after its device was disconnected is refused", async () => {
    const { token } = await pair();
    const disconnected: string[] = [];
    for (const endpoint of ["me", "library"]) {
      const before = await pair();
      // Authenticated, still working on its answer...
      const racing = call(endpoint, { token: before.token });
      // ...when the owner's Disconnect returns.
      const [device] = PairedDevices.list(t.ctx, "owner");
      if (!device) throw new Error("not paired");
      expect(PairedDevices.revoke(t.ctx, owner, device.id)).toBe(true);
      await error(await racing, 401, "token_revoked");
      disconnected.push(before.token);
    }
    for (const revoked of disconnected)
      expect((await call("me", { token: revoked })).status).toBe(401);
    // The device nobody disconnected is unaffected.
    expect((await call("me", { token })).status).toBe(200);
  });

  test("a folder removed while a listing is in flight is not in that listing", async () => {
    await Libraries.update(t.ctx, await t.drive.access("owner"), false, {
      id: libraryId,
      title: "Kitchen",
      folders: ["library/kitchen", "library/garage"],
      acknowledgedDevices: [],
    });
    const { token } = await pair();
    const racing = call("library", { token });
    // Save commits the new folders in one transaction, as Libraries.update does.
    t.drive.sqlite.run(
      "DELETE FROM nimbus_library_folder WHERE library_id = ? AND path = 'library/garage'",
      [libraryId],
    );
    t.drive.sqlite.run(
      "UPDATE nimbus_library SET updated_at = updated_at + 1 WHERE id = ?",
      [libraryId],
    );
    const listed = libraryBody.parse(await (await racing).json());
    expect(listed.items.map((item) => item.name)).not.toContain(
      "Bike repair notes.pdf",
    );
  });
});

test("an unreadable folder inside a library is skipped, not a failure", async () => {
  await t.drive.write("library/kitchen/Locked/Inside.md");
  await t.drive.write("library/kitchen/Sealed/Inside.md");
  // Listable but not searchable, and not even listable.
  await chmod(t.drive.absolute("library/kitchen/Locked"), 0o644);
  await chmod(t.drive.absolute("library/kitchen/Sealed"), 0o000);
  try {
    const { token } = await pair();
    const response = await call("library", { token });
    expect(response.status).toBe(200);
    const names = libraryBody
      .parse(await response.json())
      .items.map((item) => item.name);
    expect(names).toContain("Trail map.pdf");
    expect(names).not.toContain("Inside.md");
  } finally {
    await chmod(t.drive.absolute("library/kitchen/Locked"), 0o755);
    await chmod(t.drive.absolute("library/kitchen/Sealed"), 0o755);
  }
});
