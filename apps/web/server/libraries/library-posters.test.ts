import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
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
import { PosterRender } from "../poster-render";

/**
 * Posters through the library API's handler, with small files generated here and the real
 * decoders, and responses checked against docs/library-api/openapi.yaml.
 */

const decoders = ["ffmpeg", "pdftoppm", "pdfinfo", "prlimit"] as const;
const missing = decoders.filter((name) => Bun.which(name) === null);
if (missing.length)
  console.warn(
    `Skipping the library poster tests: ${missing.join(", ")} not found on PATH. Install ffmpeg, poppler-utils and util-linux to run them.`,
  );

const contractFile = fileURLToPath(
  new URL("../../../../docs/library-api/openapi.yaml", import.meta.url),
);
const definitions: unknown = JSON.parse(
  JSON.stringify(
    z
      .object({
        components: z.object({ schemas: z.record(z.string(), z.unknown()) }),
      })
      .parse(Bun.YAML.parse(await Bun.file(contractFile).text())).components
      .schemas,
  ).replaceAll("#/components/schemas/", "#/$defs/"),
);
const isSchemaMap = (
  value: unknown,
): value is Record<string, JSONSchema.JSONSchema> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(
    (schema) => typeof schema === "object" && schema !== null,
  );
if (!isSchemaMap(definitions)) throw new Error("The contract has no schemas.");
const contract = (name: string) =>
  z.fromJSONSchema({ $ref: `#/$defs/${name}`, $defs: definitions });

async function conforming(response: Response, schema: string) {
  const body: unknown = await response.json();
  const checked = contract(schema).safeParse(body);
  if (!checked.success)
    throw new Error(
      `${schema} does not match the contract: ${JSON.stringify(checked.error.issues)} in ${JSON.stringify(body)}`,
    );
  return body;
}

const posterShape = z
  .object({ url: z.string(), width: z.number(), height: z.number() })
  .or(z.object({ url: z.string(), width: z.null(), height: z.null() }))
  .nullable();
const listingShape = z.object({
  items: z.array(
    z.object({ id: z.string(), name: z.string(), poster: posterShape }),
  ),
});
const errorShape = z.object({ error: z.object({ code: z.string() }) });

/** A one-page PDF of a 300×450pt portrait page with a filled rectangle. */
function pdf() {
  const content = "0.2 0.4 0.8 rg 20 20 260 410 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 450] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

let fixtures: string;
const video = (name: string, size: string, duration: string) => {
  const made = Bun.spawnSync([
    Bun.which("ffmpeg") ?? "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${size}:rate=10:duration=${duration}`,
    "-c:v",
    "mpeg4",
    "-y",
    path.join(fixtures, name),
  ]);
  if (made.exitCode !== 0) throw new Error(`ffmpeg could not make ${name}.`);
  return Bun.file(path.join(fixtures, name)).bytes();
};

let clip: Uint8Array;
let shortClip: Uint8Array;
let photo: Uint8Array;
beforeAll(async () => {
  if (missing.length) return;
  fixtures = await mkdtemp(path.join(os.tmpdir(), "nimbus-posters-"));
  clip = await video("clip.mp4", "640x360", "4");
  shortClip = await video("short.mp4", "320x240", "0.5");
  photo = new Uint8Array(
    await sharp({
      create: {
        width: 2400,
        height: 1200,
        channels: 3,
        background: "#8a5a2b",
      },
    })
      .jpeg()
      .toBuffer(),
  );
  await rm(fixtures, { recursive: true, force: true });
});

let t: LibraryTest;
let libraryId: string;
beforeEach(async () => {
  if (missing.length) return;
  t = await openLibraryTest();
  const files: [string, string | Uint8Array][] = [
    ["library/kitchen/Guides/Sourdough basics.mp4", clip],
    ["library/kitchen/Guides/Quick fold.mp4", shortClip],
    ["library/kitchen/Maps/Trail map.pdf", pdf()],
    ["library/kitchen/Ridge photo.jpg", photo],
    ["library/kitchen/Bike repair notes.md", "chain"],
    ["library/kitchen/Broken.mp4", "not a video"],
    ["library/garage/Wheel truing.pdf", pdf()],
    ["other/Not shared.pdf", pdf()],
  ];
  for (const [file, content] of files) {
    await t.drive.write(file);
    await writeFile(t.drive.absolute(file), content);
  }
  const created = await Libraries.create(
    t.ctx,
    await t.drive.access("owner"),
    false,
    { title: "Kitchen", folders: ["library/kitchen"] },
  );
  if (!created.ok) throw new Error(created.error.message);
  libraryId = created.value.id;
});
afterEach(async () => {
  if (missing.length) return;
  await t.close();
});

let paired = 0;
/** A device paired with `library` by `account` through the pairing steps, and its token. */
async function pair(library = libraryId, account: "owner" | "alice" = "owner") {
  const address = `198.51.100.${++paired}`;
  const started = DevicePairing.start(t.ctx, "Kitchen tablet", address);
  if (!started.ok) throw new Error(started.error.message);
  const session = t.signIn(account);
  const shown = await DevicePairing.review(
    t.ctx,
    session,
    started.value.pairingCode,
    address,
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
    address,
  );
  const polled = DevicePairing.poll(t.ctx, started.value.deviceCode, address);
  if (!polled.ok || polled.value.status !== "approved")
    throw new Error("not approved");
  return polled.value.token;
}

const call = (
  endpoint: string,
  token: string,
  init: {
    query?: string;
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-nimbus-client-ip", "192.0.2.60");
  return LibraryHttp.handle(
    t.ctx,
    new Request(
      `${testOrigin}/api/library/v1/${endpoint}${init.query ? `?${init.query}` : ""}`,
      { method: init.method ?? "GET", headers, signal: init.signal },
    ),
    endpoint,
  );
};

async function listing(token: string) {
  const response = await call("library", token);
  expect(response.status).toBe(200);
  return listingShape.parse(await conforming(response, "LibraryResponse"));
}

async function idOf(token: string, name: string) {
  const item = (await listing(token)).items.find(
    (entry) => entry.name === name,
  );
  if (!item) throw new Error(`${name} is not listed`);
  return item.id;
}

async function poster(token: string, id: string, query?: string) {
  const response = await call(`items/${id}/poster`, token, { query });
  expect(response.status).toBe(200);
  const body = new Uint8Array(await response.arrayBuffer());
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("content-length")).toBe(String(body.byteLength));
  expect(response.headers.get("cache-control")).toBe("private, no-cache");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const { format, width, height } = await sharp(body).metadata();
  expect(format).toBe("jpeg");
  return { etag: response.headers.get("etag") ?? "", width, height };
}

async function refusal(response: Response) {
  const text = await response.text();
  expect(contract("Error").safeParse(JSON.parse(text)).success).toBe(true);
  return { status: response.status, text };
}

describe.skipIf(missing.length > 0)(
  "library posters (requires ffmpeg, pdftoppm, pdfinfo and prlimit)",
  () => {
    test("each kind at each width, never larger than its source", async () => {
      const token = await pair();
      const expected: Record<string, [number, number][]> = {
        // 640×360 video: never enlarged.
        "Sourdough basics.mp4": [
          [400, 225],
          [640, 360],
          [640, 360],
        ],
        // A portrait page has no pixels of its own: drawn at each width.
        "Trail map.pdf": [
          [400, 600],
          [800, 1200],
          [1920, 2880],
        ],
        "Ridge photo.jpg": [
          [400, 200],
          [800, 400],
          [1920, 960],
        ],
        // Shorter than the usual offsets: its first frame.
        "Quick fold.mp4": [
          [320, 240],
          [320, 240],
          [320, 240],
        ],
      };
      for (const [name, sizes] of Object.entries(expected)) {
        const id = await idOf(token, name);
        for (const [index, w] of [400, 800, 1920].entries()) {
          const drawn = await poster(token, id, `w=${w}`);
          expect([name, w, drawn.width, drawn.height]).toEqual([
            name,
            w,
            ...(sizes[index] ?? []),
          ]);
          expect(drawn.etag).toEndWith(`-${w}"`);
        }
      }
    });

    test("a dozen posters asked for at once are all drawn, sharing renders", async () => {
      const token = await pair();
      const names = [
        "Sourdough basics.mp4",
        "Quick fold.mp4",
        "Trail map.pdf",
        "Ridge photo.jpg",
      ];
      const ids = await Promise.all(names.map((name) => idOf(token, name)));
      const answers = await Promise.all(
        ids.flatMap((id) =>
          [400, 800, 1920, 400].map((w) =>
            call(`items/${id}/poster`, token, { query: `w=${w}` }),
          ),
        ),
      );
      expect(answers.map((answer) => answer.status)).toEqual(
        Array.from({ length: 16 }, () => 200),
      );
      const drawn = await Promise.all(
        answers.map(async (answer) => {
          const body = new Uint8Array(await answer.arrayBuffer());
          expect(answer.headers.get("content-length")).toBe(
            String(body.byteLength),
          );
          return (await sharp(body).metadata()).width;
        }),
      );
      expect(drawn).toEqual([
        400, 640, 640, 400, 320, 320, 320, 320, 400, 800, 1920, 400, 400, 800,
        1920, 400,
      ]);
    });

    test("other widths round to the nearest size, and a missing one is 800", async () => {
      const token = await pair();
      const id = await idOf(token, "Ridge photo.jpg");
      for (const [query, w] of [
        [undefined, 800],
        ["w=0", 400],
        ["w=599", 400],
        ["w=600", 800],
        ["w=1359", 800],
        ["w=1360", 1920],
        ["w=99999", 1920],
      ] as const)
        expect((await poster(token, id, query)).etag).toEndWith(`-${w}"`);
      const bad = await call(`items/${id}/poster`, token, { query: "w=wide" });
      expect(bad.status).toBe(400);
      expect(errorShape.parse(await conforming(bad, "Error")).error.code).toBe(
        "invalid_request",
      );
    });

    test("an unchanged poster revalidates to 304, and HEAD has its headers", async () => {
      const token = await pair();
      const id = await idOf(token, "Sourdough basics.mp4");
      const { etag } = await poster(token, id, "w=400");
      const again = await call(`items/${id}/poster`, token, {
        query: "w=400",
        headers: { "if-none-match": etag },
      });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      expect(await again.text()).toBe("");
      // Another width is another representation.
      expect(
        (
          await call(`items/${id}/poster`, token, {
            query: "w=800",
            headers: { "if-none-match": etag },
          })
        ).status,
      ).toBe(200);
      const head = await call(`items/${id}/poster`, token, {
        query: "w=400",
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("image/jpeg");
      expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
      expect(await head.text()).toBe("");
    });

    test("the listing names posters without decoding, and gives sizes once drawn", async () => {
      const token = await pair();
      const spawn = spyOn(Bun, "spawn");
      try {
        const before = await listing(token);
        expect(spawn).not.toHaveBeenCalled();
        const byName = new Map(
          before.items.map((item) => [item.name, item.poster]),
        );
        const video = before.items.find(
          (item) => item.name === "Sourdough basics.mp4",
        );
        expect(byName.get("Sourdough basics.mp4")).toEqual({
          url: `/api/library/v1/items/${video?.id}/poster`,
          width: null,
          height: null,
        });
        expect(byName.get("Bike repair notes.md")).toBeNull();
        for (const name of [
          "Sourdough basics.mp4",
          "Trail map.pdf",
          "Ridge photo.jpg",
        ])
          await poster(token, await idOf(token, name), "w=400");
        // The spy sees the decoders that drawing starts.
        expect(spawn).toHaveBeenCalled();
        spawn.mockClear();
        const after = new Map(
          (await listing(token)).items.map((item) => [item.name, item.poster]),
        );
        expect(spawn).not.toHaveBeenCalled();
        expect(after.get("Sourdough basics.mp4")).toMatchObject({
          width: 640,
          height: 360,
        });
        expect(after.get("Trail map.pdf")).toMatchObject({
          width: 300,
          height: 450,
        });
        expect(after.get("Ridge photo.jpg")).toMatchObject({
          width: 2400,
          height: 1200,
        });
        const item = await call(
          `items/${await idOf(token, "Trail map.pdf")}`,
          token,
        );
        expect(await conforming(item, "Item")).toMatchObject({
          poster: { width: 300, height: 450 },
        });
      } finally {
        spawn.mockRestore();
      }
    });

    test("other kinds have no poster", async () => {
      const token = await pair();
      const id = await idOf(token, "Bike repair notes.md");
      const response = await call(`items/${id}/poster`, token);
      expect(response.status).toBe(404);
      expect(
        errorShape.parse(await conforming(response, "Error")).error.code,
      ).toBe("poster_not_available");
    });

    test("an item without a poster whose file is gone answers as an unknown id", async () => {
      const token = await pair();
      const id = await idOf(token, "Bike repair notes.md");
      // Still cataloged: the file went away after the listing.
      await rm(t.drive.absolute("library/kitchen/Bike repair notes.md"));
      const gone = await refusal(await call(`items/${id}/poster`, token));
      const unknown = await refusal(
        await call("items/itm_doesnotexist000000/poster", token),
      );
      expect(gone).toEqual(unknown);
    });

    test("an undecodable file fails once and is not drawn again", async () => {
      const token = await pair();
      const id = await idOf(token, "Broken.mp4");
      const first = await call(`items/${id}/poster`, token);
      expect(first.status).toBe(422);
      expect(
        errorShape.parse(await conforming(first, "Error")).error.code,
      ).toBe("poster_failed");
      const spawn = spyOn(Bun, "spawn");
      try {
        const second = await call(`items/${id}/poster`, token, {
          query: "w=1920",
        });
        expect(second.status).toBe(422);
        // No poster exists for this version, so nothing about it is unchanged.
        const anything = await call(`items/${id}/poster`, token, {
          headers: { "if-none-match": "*" },
        });
        expect(anything.status).toBe(422);
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        spawn.mockRestore();
      }
      const listed = (await listing(token)).items.find(
        (item) => item.id === id,
      );
      expect(listed?.poster).toBeNull();
    });

    test("anything a device cannot reach is the same 404, and a revoked token gets 401", async () => {
      await t.drive.write("library/maps/Ridge map.pdf");
      await writeFile(t.drive.absolute("library/maps/Ridge map.pdf"), pdf());
      await t.drive.grant("library/maps", "alice", "admin");
      const garageGrant = await t.drive.grant(
        "library/garage",
        "alice",
        "admin",
      );
      const maps = await Libraries.create(
        t.ctx,
        await t.drive.access("alice"),
        false,
        { title: "Maps", folders: ["library/maps", "library/garage"] },
      );
      if (!maps.ok) throw new Error(maps.error.message);
      const aliceToken = await pair(maps.value.id, "alice");
      const hidden = await idOf(aliceToken, "Wheel truing.pdf");
      await t.drive.store.removeGrant(garageGrant.id);
      LibraryCatalog.resetForTest();

      const token = await pair();
      const foreign = await idOf(aliceToken, "Ridge map.pdf");
      const swapped = await idOf(token, "Ridge photo.jpg");
      const gone = await idOf(token, "Trail map.pdf");
      await rm(t.drive.absolute("library/kitchen/Maps/Trail map.pdf"));
      // A file swapped for a symlink to one outside the library.
      await rm(t.drive.absolute("library/kitchen/Ridge photo.jpg"));
      await symlink(
        t.drive.absolute("other/Not shared.pdf"),
        t.drive.absolute("library/kitchen/Ridge photo.jpg"),
      );
      LibraryCatalog.resetForTest();
      await listing(token);
      const kitchen = await Promise.all(
        [foreign, gone, swapped, "itm_doesnotexist000000"].map(async (id) =>
          refusal(await call(`items/${id}/poster`, token)),
        ),
      );
      const maps404 = await refusal(
        await call(`items/${hidden}/poster`, aliceToken),
      );
      const all = [...kitchen, maps404];
      expect(new Set(all.map((answer) => answer.status))).toEqual(
        new Set([404]),
      );
      expect(new Set(all.map((answer) => answer.text)).size).toBe(1);
      expect(JSON.parse(maps404.text)).toMatchObject({
        error: { code: "item_not_found" },
      });

      const video = await idOf(token, "Sourdough basics.mp4");
      await PairedDevices.revokeForUser(
        t.ctx,
        "owner",
        "signed_out_everywhere",
      );
      const revoked = await call(`items/${video}/poster`, token);
      expect(revoked.status).toBe(401);
      expect(
        errorShape.parse(await conforming(revoked, "Error")).error.code,
      ).toBe("token_revoked");
    });

    test("access removed while a poster is drawn ends the answer like an unknown id", async () => {
      const grant = await t.drive.grant("library/garage", "alice", "admin");
      const garage = await Libraries.create(
        t.ctx,
        await t.drive.access("alice"),
        false,
        { title: "Garage", folders: ["library/garage"] },
      );
      if (!garage.ok) throw new Error(garage.error.message);
      const token = await pair(garage.value.id, "alice");
      const id = await idOf(token, "Wheel truing.pdf");
      const draw = PosterRender.master;
      const drawing = spyOn(PosterRender, "master").mockImplementation(
        async (...args) => {
          await t.drive.store.removeGrant(grant.id);
          return draw(...args);
        },
      );
      try {
        const removed = await refusal(await call(`items/${id}/poster`, token));
        expect(drawing).toHaveBeenCalled();
        const unknown = await refusal(
          await call("items/itm_doesnotexist000000/poster", token),
        );
        expect(removed).toEqual(unknown);
        expect(removed.status).toBe(404);
      } finally {
        drawing.mockRestore();
      }
    });

    test("a drawing everyone left is stopped and leaves no record", async () => {
      const token = await pair();
      const id = await idOf(token, "Sourdough basics.mp4");
      const leaving = new AbortController();
      const draw = PosterRender.master;
      const seen: { signal: AbortSignal | null } = { signal: null };
      const drawing = spyOn(PosterRender, "master").mockImplementation(
        async (source, file, signal) => {
          seen.signal = signal;
          leaving.abort();
          return draw(source, file, signal);
        },
      );
      try {
        const left = await call(`items/${id}/poster`, token, {
          signal: leaving.signal,
        });
        expect(left.status).toBe(503);
        expect(seen.signal).not.toBeNull();
        expect(seen.signal?.aborted).toBe(true);
      } finally {
        drawing.mockRestore();
      }
      // Not remembered as a failure: the next request draws it.
      expect((await poster(token, id, "w=400")).width).toBe(400);
    });

    test("a changed file gets a new poster, never the old one", async () => {
      const token = await pair();
      const id = await idOf(token, "Ridge photo.jpg");
      const before = await poster(token, id, "w=400");
      const taller = await sharp({
        create: {
          width: 1000,
          height: 2000,
          channels: 3,
          background: "#204060",
        },
      })
        .jpeg()
        .toBuffer();
      await writeFile(
        t.drive.absolute("library/kitchen/Ridge photo.jpg"),
        taller,
      );
      const after = await poster(token, id, "w=400");
      expect(after.etag).not.toBe(before.etag);
      expect([after.width, after.height]).toEqual([400, 800]);
    });
  },
);
