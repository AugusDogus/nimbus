import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { Server } from "bun";
import { z } from "zod";
import { DevicePairing } from "./device-pairing";
import { Libraries } from "./libraries";
import { LibraryCatalog } from "./library-catalog";
import { LibraryHttp } from "./library-http";
import { openLibraryTest, type LibraryTest } from "./library-testing";
import { MediaTickets, MAX_TICKETS_PER_DEVICE } from "./media-tickets";
import { PairedDevices } from "./paired-devices";
import { Transfers } from "./transfers";

/**
 * The library's file endpoints over a real socket, as a client and a media player use them:
 * whole files and byte ranges with a bearer token, and media addresses with their cookie.
 */

const MiB = 1024 * 1024;
/** A pattern file: byte i is i % 251, so any range can be checked for where it came from. */
const pattern = (size: number) =>
  Uint8Array.from({ length: size }, (_, index) => index % 251);
const size = 6 * MiB + 123;

let t: LibraryTest;
let server: Server<undefined>;
let base: string;
let libraryId: string;
let paired = 0;

beforeEach(async () => {
  t = await openLibraryTest();
  MediaTickets.resetForTest();
  await t.drive.write("library/kitchen/Guides/Pattern.mp4");
  await writeFile(
    t.drive.absolute("library/kitchen/Guides/Pattern.mp4"),
    pattern(size),
  );
  await t.drive.write("library/kitchen/Small notes.md", "proofing times");
  await t.drive.write("library/garage/Bike repair notes.pdf", "chain");
  await t.drive.write("other/Not shared.mp4", "outside");
  const created = await Libraries.create(
    t.ctx,
    await t.drive.access("owner"),
    false,
    { title: "Kitchen", folders: ["library/kitchen"] },
  );
  if (!created.ok) throw new Error(created.error.message);
  libraryId = created.value.id;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const prefix = "/api/library/v1/";
      const { pathname } = new URL(request.url);
      const forwarded = new Request(request, {
        headers: new Headers(request.headers),
      });
      forwarded.headers.set("x-nimbus-client-ip", "192.0.2.80");
      return LibraryHttp.handle(
        t.ctx,
        forwarded,
        decodeURIComponent(pathname.slice(prefix.length)),
      );
    },
  });
  base = `http://localhost:${server.port}/api/library/v1`;
});
afterEach(async () => {
  await server.stop(true);
  MediaTickets.resetForTest();
  await t.close();
});

/** A device paired with `library` through the pairing steps, and its token. */
async function pair(library = libraryId) {
  const started = DevicePairing.start(
    t.ctx,
    "Reader",
    `198.51.100.${++paired}`,
  );
  if (!started.ok) throw new Error(started.error.message);
  const session = t.signIn("owner");
  const shown = await DevicePairing.review(
    t.ctx,
    session,
    started.value.pairingCode,
    `198.51.100.${paired}`,
  );
  if (!shown.ok) throw new Error(shown.error.message);
  await DevicePairing.decide(
    t.ctx,
    session,
    {
      pairingId: shown.value.pairingId,
      ticket: shown.value.ticket,
      decision: { kind: "approve", libraryId: library },
    },
    `198.51.100.${paired}`,
  );
  const polled = DevicePairing.poll(
    t.ctx,
    started.value.deviceCode,
    `198.51.100.${paired}`,
  );
  if (!polled.ok || polled.value.status !== "approved")
    throw new Error("not approved");
  const grant = PairedDevices.list(t.ctx, "owner")[0];
  if (!grant) throw new Error("not listed");
  return { token: polled.value.token, deviceId: grant.id };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const listing = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string() })),
});

async function idOf(token: string, name: string) {
  const body = listing.parse(
    await (await fetch(`${base}/library`, { headers: auth(token) })).json(),
  );
  const item = body.items.find((entry) => entry.name === name);
  if (!item) throw new Error(`${name} is not listed`);
  return item.id;
}

const errorCode = async (response: Response) =>
  z
    .object({ error: z.object({ code: z.string() }) })
    .parse(await response.json()).error.code;

/** Bytes `start` to `end` of the pattern. */
const expected = (start: number, end: number) =>
  pattern(end + 1).subarray(start, end + 1);

describe("one item", () => {
  test("is described as the listing describes it, and anything else is the same 404", async () => {
    const { token } = await pair();
    const id = await idOf(token, "Pattern.mp4");
    const response = await fetch(`${base}/items/${id}`, {
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id,
      name: "Pattern.mp4",
      kind: "video",
      contentType: "video/mp4",
      sizeBytes: size,
      folder: 0,
      path: "Guides/Pattern.mp4",
    });
    // Another library's item, an unknown id and a removed file look alike.
    const garage = await Libraries.create(
      t.ctx,
      await t.drive.access("owner"),
      false,
      { title: "Garage", folders: ["library/garage"] },
    );
    if (!garage.ok) throw new Error(garage.error.message);
    const other = await pair(garage.value.id);
    const foreign = await idOf(other.token, "Bike repair notes.pdf");
    const small = await idOf(token, "Small notes.md");
    await rm(t.drive.absolute("library/kitchen/Small notes.md"));
    LibraryCatalog.resetForTest();
    await fetch(`${base}/library`, { headers: auth(token) });
    const answers = await Promise.all(
      [foreign, small, "itm_doesnotexist000000", "notanid"].map(
        async (candidate) => {
          const answer = await fetch(`${base}/items/${candidate}/file`, {
            headers: auth(token),
          });
          return { status: answer.status, body: await answer.text() };
        },
      ),
    );
    expect(new Set(answers.map((answer) => answer.status))).toEqual(
      new Set([404]),
    );
    expect(new Set(answers.map((answer) => answer.body)).size).toBe(1);
    // A path that tries to leave the item reaches no item at all.
    const escaping = await fetch(`${base}/items/itm_..%2f..%2fother/file`, {
      headers: auth(token),
    });
    expect(escaping.status).toBe(404);
  });
});

describe("file bytes with the bearer token", () => {
  test("whole, ranged, suffix, unsatisfiable, HEAD and If-Range", async () => {
    const { token } = await pair();
    const id = await idOf(token, "Pattern.mp4");
    const url = `${base}/items/${id}/file`;
    const whole = await fetch(url, { headers: auth(token) });
    expect(whole.status).toBe(200);
    for (const [name, value] of [
      ["content-type", "video/mp4"],
      ["content-length", String(size)],
      ["accept-ranges", "bytes"],
      ["cache-control", "private, no-cache"],
      ["x-content-type-options", "nosniff"],
      ["content-security-policy", "sandbox; default-src 'none'"],
    ])
      expect(whole.headers.get(name)).toBe(value);
    expect(whole.headers.get("content-disposition")).toStartWith("inline");
    const etag = whole.headers.get("etag") ?? "";
    expect(etag).toMatch(/^"v1_[A-Za-z0-9_-]+"$/);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(pattern(size));

    const range = async (header: string, extra: Record<string, string> = {}) =>
      fetch(url, { headers: { ...auth(token), range: header, ...extra } });
    const first = await range("bytes=0-1");
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
    expect(first.headers.get("content-length")).toBe("2");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(expected(0, 1));
    const open = await range(`bytes=${4 * MiB}-`);
    expect(open.headers.get("content-range")).toBe(
      `bytes ${4 * MiB}-${size - 1}/${size}`,
    );
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(
      expected(4 * MiB, size - 1),
    );
    const suffix = await range("bytes=-500");
    expect(suffix.headers.get("content-range")).toBe(
      `bytes ${size - 500}-${size - 1}/${size}`,
    );
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(
      expected(size - 500, size - 1),
    );
    const beyond = await range(`bytes=${size}-`);
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${size}`);
    const head = await fetch(url, { method: "HEAD", headers: auth(token) });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(size));
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await range("bytes=10-19", { "if-range": etag })).status).toBe(206);
    const stale = await range("bytes=10-19", { "if-range": '"v1_stale"' });
    expect(stale.status).toBe(200);
    await stale.body?.cancel();
  });
});

describe("media addresses", () => {
  async function mint(token: string, id: string) {
    const response = await fetch(`${base}/items/${id}/stream`, {
      method: "POST",
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    const body = z
      .object({ url: z.string(), expiresAt: z.string() })
      .parse(await response.json());
    const setCookie = response.headers.get("set-cookie") ?? "";
    const [pair = ""] = setCookie.split(";");
    const address = new URL(body.url);
    return {
      url: `${base}/media/${id}${address.search}`,
      search: address.search,
      cookie: pair,
      setCookie,
      expiresAt: body.expiresAt,
    };
  }
  const media = (
    minted: { url: string; cookie: string },
    headers: Record<string, string> = {},
    method = "GET",
  ) =>
    fetch(minted.url, {
      method,
      headers: { cookie: minted.cookie, ...headers },
    });

  test("are same-origin, carry their ticket in the query only, and set a separate cookie", async () => {
    const { token } = await pair();
    const id = await idOf(token, "Pattern.mp4");
    const response = await fetch(`${base}/items/${id}/stream`, {
      method: "POST",
      headers: auth(token),
    });
    const body = z
      .object({ url: z.string(), expiresAt: z.string() })
      .parse(await response.json());
    const address = new URL(body.url);
    expect(address.origin).toBe("https://nimbus.example.test");
    expect(address.pathname).toBe(`/api/library/v1/media/${id}`);
    expect([...address.searchParams.keys()]).toEqual(["ticket"]);
    expect(Date.parse(body.expiresAt)).toBe(t.now() + 4 * 60 * 60 * 1000);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(
      /^__Secure-nimbus-media-[A-Za-z0-9_-]+=[A-Za-z0-9_-]{43};/,
    );
    for (const attribute of [
      "Path=/api/library/v1/media",
      "Max-Age=14400",
      "HttpOnly",
      "SameSite=Strict",
      "Secure",
    ])
      expect(setCookie).toContain(attribute);
    expect(setCookie).not.toContain("Domain");
    expect(setCookie).not.toContain(address.searchParams.get("ticket") ?? "-");
  });

  test("serve the ranges a player asks for when probing and seeking", async () => {
    const { token } = await pair();
    const minted = await mint(token, await idOf(token, "Pattern.mp4"));
    const probe = await media(minted, { range: "bytes=0-1" });
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
    expect(probe.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await probe.arrayBuffer())).toEqual(expected(0, 1));
    // Start playing from the beginning, then seek near the end and back.
    const start = await media(minted, { range: "bytes=0-" });
    const reader = start.body?.getReader();
    const firstChunk = await reader?.read();
    expect(firstChunk?.value?.[0]).toBe(0);
    await reader?.cancel();
    for (const [from, to] of [
      [5 * MiB, size - 1],
      [MiB + 7, 2 * MiB],
    ] as const) {
      const seek = await media(minted, { range: `bytes=${from}-${to}` });
      expect(seek.status).toBe(206);
      expect(seek.headers.get("content-length")).toBe(String(to - from + 1));
      expect(new Uint8Array(await seek.arrayBuffer())).toEqual(
        expected(from, to),
      );
    }
    const head = await media(minted, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(size));
  });

  test("answer every range in full, as a player loading a file asks", async () => {
    const { token } = await pair();
    const minted = await mint(token, await idOf(token, "Pattern.mp4"));
    const check = async (header: string, start: number, end: number) => {
      const answer = await media(minted, { range: header });
      expect(answer.status).toBe(206);
      expect(answer.headers.get("content-range")).toBe(
        `bytes ${start}-${end}/${size}`,
      );
      expect(answer.headers.get("content-length")).toBe(
        String(end - start + 1),
      );
      expect(new Uint8Array(await answer.arrayBuffer())).toEqual(
        expected(start, end),
      );
      const head = await media(minted, { range: header }, "HEAD");
      expect(head.status).toBe(206);
      for (const name of ["content-range", "content-length"])
        expect(head.headers.get(name)).toBe(answer.headers.get(name));
    };
    await check("bytes=0-1", 0, 1);
    // The whole file as one closed range, far larger than any window.
    await check(`bytes=0-${size - 1}`, 0, size - 1);
    await check(`bytes=${size - 1000}-${size - 1}`, size - 1000, size - 1);
    await check("bytes=-500", size - 500, size - 1);
    await check("bytes=1000-", 1000, size - 1);
    // Clamped to the file's size, as any range is.
    await check(`bytes=${size - 10}-${size + 5000}`, size - 10, size - 1);
  });

  test("serve several ranges held open at once", async () => {
    const { token } = await pair();
    const minted = await mint(token, await idOf(token, "Pattern.mp4"));
    const open = await Promise.all(
      [
        "bytes=0-",
        `bytes=0-${size - 1}`,
        `bytes=${size - 2000}-`,
        "bytes=-1",
      ].map((range) => media(minted, { range })),
    );
    expect(open.map((answer) => answer.status)).toEqual([206, 206, 206, 206]);
    const last = open[3];
    if (!last) throw new Error("no answer");
    expect(new Uint8Array(await last.arrayBuffer())).toEqual(
      expected(size - 1, size - 1),
    );
    for (const answer of open.slice(0, 3)) await answer.body?.cancel();
  });

  test("need both the ticket and its own cookie", async () => {
    const one = await pair();
    const two = await pair();
    const id = await idOf(one.token, "Pattern.mp4");
    const small = await idOf(one.token, "Small notes.md");
    const minted = await mint(one.token, id);
    const otherItem = await mint(one.token, small);
    const otherDevice = await mint(two.token, id);
    const tampered = minted.url.replace(
      /ticket=(.)/,
      (_, c: string) => `ticket=${c === "A" ? "B" : "A"}`,
    );
    for (const attempt of [
      fetch(minted.url),
      media({ url: minted.url, cookie: otherItem.cookie }),
      media({ url: minted.url, cookie: otherDevice.cookie }),
      media({ url: tampered, cookie: minted.cookie }),
      media({ url: `${base}/media/${id}`, cookie: minted.cookie }),
      media({
        url: `${base}/media/${small}${minted.search}`,
        cookie: minted.cookie,
      }),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("stream_invalid");
    }
    expect((await media(minted, { range: "bytes=0-0" })).status).toBe(206);
  });

  test("expire, also with a restart, and newer ones replace the oldest", async () => {
    const { token } = await pair();
    const id = await idOf(token, "Pattern.mp4");
    const minted = await mint(token, id);
    const later = [];
    for (let index = 0; index < MAX_TICKETS_PER_DEVICE; index++)
      later.push(await mint(token, id));
    const replaced = await media(minted);
    expect(await errorCode(replaced)).toBe("stream_expired");
    const [newest] = later.slice(-1);
    if (!newest) throw new Error("no ticket");
    MediaTickets.resetForTest();
    const restarted = await media(newest);
    expect(restarted.status).toBe(403);
    expect(await errorCode(restarted)).toBe("stream_expired");
    const fresh = await mint(token, id);
    t.advance(4 * 60 * 60 * 1000 + 1);
    expect(await errorCode(await media(fresh))).toBe("stream_expired");
  });

  test("a changed, replaced or moved file is never served under an old ticket", async () => {
    const { token } = await pair();
    const id = await idOf(token, "Pattern.mp4");
    const file = t.drive.absolute("library/kitchen/Guides/Pattern.mp4");
    const changed = await mint(token, id);
    await writeFile(file, pattern(size - 1));
    const answer = await media(changed);
    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("stream_source_changed");
    const swapped = await mint(token, id);
    await rm(file);
    await symlink(t.drive.absolute("other/Not shared.mp4"), file);
    const linked = await media(swapped);
    expect(linked.status).toBe(404);
    expect(await errorCode(linked)).toBe("item_not_found");
    await rm(file);
    await writeFile(file, pattern(size));
    LibraryCatalog.resetForTest();
    const freshId = await idOf(token, "Pattern.mp4");
    const moved = await mint(token, freshId);
    await rename(file, t.drive.absolute("other/Moved.mp4"));
    expect((await media(moved)).status).toBe(404);
  });

  test("a file whose folder was renamed is never served under an old ticket", async () => {
    const { token } = await pair();
    const id = await idOf(token, "Pattern.mp4");
    const minted = await mint(token, id);
    // Renaming the folder leaves the file's own size and times as they were.
    await rename(
      t.drive.absolute("library/kitchen/Guides"),
      t.drive.absolute("library/kitchen/Recipes"),
    );
    LibraryCatalog.resetForTest();
    expect(await idOf(token, "Pattern.mp4")).toBe(id);
    const answer = await media(minted, { range: "bytes=0-1" });
    expect(answer.status).toBe(409);
    expect(await errorCode(answer)).toBe("stream_source_changed");
  });

  test("end with the device or the owner's access, between ranges and during a body", async () => {
    const { token, deviceId } = await pair();
    const id = await idOf(token, "Pattern.mp4");
    const minted = await mint(token, id);
    expect((await media(minted, { range: "bytes=0-1" })).status).toBe(206);
    // Revoked during a body: the rest is never sent.
    const running = await media(minted);
    const reader = running.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    expect(
      PairedDevices.revoke(
        t.ctx,
        { id: "owner", email: "owner@example.test" },
        deviceId,
      ),
    ).toBe(true);
    let received = 0;
    const drained = (async () => {
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) return "complete";
        received += chunk.value.byteLength;
      }
    })().catch(() => "stopped");
    expect(await drained).toBe("stopped");
    expect(received).toBeLessThan(size);
    // Nothing about the transfer, or the revocation, is kept once it ended.
    expect(Transfers.size).toBe(0);
    // And the next range is refused as a revoked device, even once the ticket expired too.
    const after = await media(minted, { range: "bytes=2-3" });
    expect(after.status).toBe(401);
    expect(await errorCode(after)).toBe("token_revoked");
    t.advance(5 * 60 * 60 * 1000);
    expect(await errorCode(await media(minted))).toBe("token_revoked");
  });

  test("end when the owner can no longer share the folder", async () => {
    await t.drive.write("library/maps/Ridge.mp4", "ridge");
    const grant = await t.drive.grant("library/maps", "alice", "admin");
    const created = await Libraries.create(
      t.ctx,
      await t.drive.access("alice"),
      false,
      { title: "Maps", folders: ["library/maps"] },
    );
    if (!created.ok) throw new Error(created.error.message);
    const started = DevicePairing.start(t.ctx, "Reader", "203.0.113.9");
    if (!started.ok) throw new Error(started.error.message);
    const session = t.signIn("alice");
    const shown = await DevicePairing.review(
      t.ctx,
      session,
      started.value.pairingCode,
      "203.0.113.9",
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
      "203.0.113.9",
    );
    const polled = DevicePairing.poll(
      t.ctx,
      started.value.deviceCode,
      "203.0.113.9",
    );
    if (!polled.ok || polled.value.status !== "approved")
      throw new Error("not approved");
    const id = await idOf(polled.value.token, "Ridge.mp4");
    const minted = await mint(polled.value.token, id);
    expect((await media(minted)).status).toBe(200);
    await t.drive.store.removeGrant(grant.id);
    const refused = await media(minted);
    expect(refused.status).toBe(404);
    expect(await errorCode(refused)).toBe("item_not_found");
    const file = await fetch(`${base}/items/${id}/file`, {
      headers: auth(polled.value.token),
    });
    expect(file.status).toBe(404);
  });

  test("are limited per device to ten mints a minute", async () => {
    const { token } = await pair();
    const id = await idOf(token, "Pattern.mp4");
    await mint(token, id);
    // Ten a minute: one minted above, nine more, then refused.
    for (let index = 0; index < 9; index++) await mint(token, id);
    const eleventh = await fetch(`${base}/items/${id}/stream`, {
      method: "POST",
      headers: auth(token),
    });
    expect(eleventh.status).toBe(429);
  });
});

test("a file the server cannot open answers as an unknown item, for GET and HEAD alike", async () => {
  const { token } = await pair();
  const id = await idOf(token, "Small notes.md");
  const unknown = await fetch(`${base}/items/itm_doesnotexist000000/file`, {
    headers: auth(token),
  });
  const unknownBody = await unknown.text();
  await chmod(t.drive.absolute("library/kitchen/Small notes.md"), 0o000);
  try {
    const get = await fetch(`${base}/items/${id}/file`, {
      headers: auth(token),
    });
    expect(get.status).toBe(404);
    expect(await get.text()).toBe(unknownBody);
    const head = await fetch(`${base}/items/${id}/file`, {
      method: "HEAD",
      headers: auth(token),
    });
    expect(head.status).toBe(404);
    expect(head.headers.get("etag")).toBeNull();
    expect(head.headers.get("content-length")).not.toBe("14");
  } finally {
    await chmod(t.drive.absolute("library/kitchen/Small notes.md"), 0o644);
  }
});

test("a file with other names outside Nimbus's upload staging is neither listed nor served", async () => {
  // A second name, outside the library, for a file inside it.
  await link(
    t.drive.absolute("other/Not shared.mp4"),
    t.drive.absolute("library/kitchen/Linked.mp4"),
  );
  // A fresh upload still holds its staging name, which is Nimbus's own.
  await mkdir(t.drive.absolute(".nimbus/uploads"), { recursive: true });
  await t.drive.write("library/kitchen/Uploaded.md", "just uploaded");
  await link(
    t.drive.absolute("library/kitchen/Uploaded.md"),
    t.drive.absolute(".nimbus/uploads/upload-id"),
  );
  const { token } = await pair();
  const names = listing
    .parse(
      await (await fetch(`${base}/library`, { headers: auth(token) })).json(),
    )
    .items.map((item) => item.name);
  expect(names).toContain("Uploaded.md");
  expect(names).not.toContain("Linked.mp4");
  // Linked after it was listed: its id no longer opens.
  const small = await idOf(token, "Small notes.md");
  await rm(t.drive.absolute("library/kitchen/Small notes.md"));
  await link(
    t.drive.absolute("other/Not shared.mp4"),
    t.drive.absolute("library/kitchen/Small notes.md"),
  );
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${base}/items/${small}/file`, {
      method,
      headers: auth(token),
    });
    expect(response.status).toBe(404);
  }
  const uploaded = await idOf(token, "Uploaded.md");
  expect(
    (await fetch(`${base}/items/${uploaded}/file`, { headers: auth(token) }))
      .status,
  ).toBe(200);
});

describe("a whole file sent in chunks stops when what allowed it ends", () => {
  const large = 9 * MiB;
  /** Start sending Large.mp4 whole, without a range, to a device of `owner`'s library. */
  async function sending(owner: "owner" | "alice", folders: string[]) {
    await writeFile(
      t.drive.absolute("library/kitchen/Large.mp4"),
      pattern(large),
    );
    const created = await Libraries.create(
      t.ctx,
      await t.drive.access(owner),
      false,
      { title: "Large", folders },
    );
    if (!created.ok) throw new Error(created.error.message);
    const started = DevicePairing.start(t.ctx, "Reader", "203.0.113.40");
    if (!started.ok) throw new Error(started.error.message);
    const session = t.signIn(owner);
    const shown = await DevicePairing.review(
      t.ctx,
      session,
      started.value.pairingCode,
      "203.0.113.40",
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
      "203.0.113.40",
    );
    const polled = DevicePairing.poll(
      t.ctx,
      started.value.deviceCode,
      "203.0.113.40",
    );
    if (!polled.ok || polled.value.status !== "approved")
      throw new Error("not approved");
    const token = polled.value.token;
    const id = await idOf(token, "Large.mp4");
    const minted = await fetch(`${base}/items/${id}/stream`, {
      method: "POST",
      headers: auth(token),
    });
    const { url } = z.object({ url: z.string() }).parse(await minted.json());
    const cookie = (minted.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const response = await fetch(`${base}/media/${id}${new URL(url).search}`, {
      headers: { cookie },
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    expect((await reader.read()).done).toBe(false);
    return { libraryId: created.value.id, reader };
  }
  const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let received = 0;
    return (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return "complete";
        received += chunk.value.byteLength;
      }
    })()
      .catch(() => "stopped")
      .then((outcome) => ({ outcome, received }));
  };

  test("when its folder is removed from the library", async () => {
    const { libraryId: id, reader } = await sending("owner", [
      "library/kitchen",
      "library/garage",
    ]);
    const updated = await Libraries.update(
      t.ctx,
      await t.drive.access("owner"),
      false,
      {
        id,
        title: "Large",
        folders: ["library/garage"],
        acknowledgedDevices: [],
      },
    );
    expect(updated.ok).toBe(true);
    const result = await drain(reader);
    expect(result.outcome).toBe("stopped");
    expect(result.received).toBeLessThan(large);
  });

  test("when the owner may no longer share the folder", async () => {
    const grant = await t.drive.grant("library/kitchen", "alice", "admin");
    const { reader } = await sending("alice", ["library/kitchen"]);
    await t.drive.store.removeGrant(grant.id);
    const result = await drain(reader);
    expect(result.outcome).toBe("stopped");
  });
});
