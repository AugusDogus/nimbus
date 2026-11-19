import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { readdirSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAccess } from "@nimbus/api/access";
import { createTestDriveStore } from "@nimbus/api/testing";
import {
  heldDescriptorCount,
  maxHeldDescriptors,
  releaseHeldDescriptorsForTest,
  serveFile,
  servedVersion,
  serveStoredFile,
  serveZip,
  stillNamed,
} from "./file-response";
import { hookFileHandle } from "./file-handle-testing";
import { FileVersion } from "./file-version";

let root: string;
let previousRoot: string | undefined;
const admin = () => getAccess(createTestDriveStore().store, "user-1");
const get = (headers: Record<string, string> = {}, method = "GET") =>
  new Request("http://localhost/download", { method, headers });

beforeEach(async () => {
  previousRoot = process.env.NIMBUS_DATA_ROOT;
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-file-response-"));
  process.env.NIMBUS_DATA_ROOT = root;
  await mkdir(path.join(root, "docs/inner"), { recursive: true });
  await writeFile(path.join(root, "docs/a.txt"), "0123456789");
  await writeFile(path.join(root, "docs/inner/b.txt"), "bee");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
  else process.env.NIMBUS_DATA_ROOT = previousRoot;
});

test("serves whole files, single ranges and HEAD with matching lengths", async () => {
  const access = await admin();
  const whole = await serveFile(get(), "docs/a.txt", access);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-length")).toBe("10");
  expect(await whole.text()).toBe("0123456789");
  const range = await serveFile(
    get({ range: "bytes=2-4" }),
    "docs/a.txt",
    access,
  );
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 2-4/10");
  expect(await range.text()).toBe("234");
  const suffix = await serveFile(
    get({ range: "bytes=-3" }),
    "docs/a.txt",
    access,
  );
  expect(await suffix.text()).toBe("789");
  const beyond = await serveFile(
    get({ range: "bytes=20-" }),
    "docs/a.txt",
    access,
  );
  expect(beyond.status).toBe(416);
  const head = await serveFile(get({}, "HEAD"), "docs/a.txt", access);
  expect(head.headers.get("content-length")).toBe("10");
  expect(head.body).toBeNull();
});

test("ranges it does not serve are ignored, and the whole file is sent", async () => {
  const access = await admin();
  for (const range of ["bytes=9-2", "bytes=0-1,4-5", "bytes=x-", "items=0-1"]) {
    const response = await serveFile(get({ range }), "docs/a.txt", access);
    expect({ range, status: response.status }).toEqual({ range, status: 200 });
    expect(await response.text()).toBe("0123456789");
  }
});

test("conditional requests answer 304 or 412 from the file's validators", async () => {
  const access = await admin();
  const first = await serveFile(get(), "docs/a.txt", access);
  const etag = first.headers.get("etag") ?? "";
  const modified = first.headers.get("last-modified") ?? "";
  await first.body?.cancel();
  const status = async (headers: Record<string, string>, method = "GET") => {
    const response = await serveFile(
      get(headers, method),
      "docs/a.txt",
      access,
    );
    await response.body?.cancel();
    return response.status;
  };
  expect(await status({ "if-none-match": etag })).toBe(304);
  expect(await status({ "if-none-match": `W/${etag}` })).toBe(304);
  expect(await status({ "if-none-match": "*" }, "HEAD")).toBe(304);
  expect(await status({ "if-none-match": '"other"' })).toBe(200);
  expect(await status({ "if-modified-since": modified })).toBe(304);
  expect(await status({ "if-modified-since": new Date(0).toUTCString() })).toBe(
    200,
  );
  // If-None-Match takes precedence over If-Modified-Since.
  expect(
    await status({ "if-none-match": '"other"', "if-modified-since": modified }),
  ).toBe(200);
  expect(await status({ "if-match": '"other"' })).toBe(412);
  expect(await status({ "if-match": `${etag}, "x"` })).toBe(200);
  expect(await status({ "if-match": "*" })).toBe(200);
  // If-Match uses strong comparison.
  expect(await status({ "if-match": `W/${etag}` })).toBe(412);
  expect(
    await status({ "if-unmodified-since": new Date(0).toUTCString() }),
  ).toBe(412);
  expect(await status({ "if-unmodified-since": modified })).toBe(200);
  const notModified = await serveFile(
    get({ "if-none-match": etag }),
    "docs/a.txt",
    access,
  );
  expect(notModified.headers.get("etag")).toBe(etag);
  expect(notModified.body).toBeNull();
});

test("a file replaced after its response starts is served whole, with its own length", async () => {
  const access = await admin();
  const response = await serveFile(get(), "docs/a.txt", access);
  await writeFile(path.join(root, "docs/new.txt"), "short");
  await rename(path.join(root, "docs/new.txt"), path.join(root, "docs/a.txt"));
  expect(response.headers.get("content-length")).toBe("10");
  expect(await response.text()).toBe("0123456789");
  expect(await readFile(path.join(root, "docs/a.txt"), "utf8")).toBe("short");
});

test("symlinks are never served", async () => {
  const access = await admin();
  await symlink(
    path.join(root, "docs/a.txt"),
    path.join(root, "docs/link.txt"),
  );
  await expect(serveFile(get(), "docs/link.txt", access)).rejects.toMatchObject(
    {
      code: "FORBIDDEN",
    },
  );
});

test("folder ZIPs list readable contents relative to the folder", async () => {
  const access = await admin();
  const response = await serveZip("docs", access);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  for (const name of ["a.txt", "inner/", "inner/b.txt"])
    expect(text).toContain(name);
  expect(text).not.toContain("docs/");
  // STORE keeps file content verbatim inside the archive.
  expect(text).toContain("0123456789");
  await expect(serveZip("docs/a.txt", access)).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});

test("special files are refused without waiting on them", async () => {
  const access = await admin();
  Bun.spawnSync(["mkfifo", path.join(root, "docs/pipe")]);
  // Refused as everywhere else in the drive: pipes, sockets and devices are not drive content.
  await expect(serveFile(get(), "docs/pipe", access)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(serveFile(get(), "docs/missing", access)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

/** Serve one download over real HTTP, changing the file after its headers are decided. */
async function overHttp(change: (file: string) => Promise<void>) {
  const access = await admin();
  const file = path.join(root, "docs/large.bin");
  await writeFile(file, Buffer.alloc(4 << 20, 65));
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const response = await serveFile(request, "docs/large.bin", access);
      await change(file);
      return response;
    },
  });
  try {
    const response = await fetch(`http://localhost:${server.port}/`);
    const advertised = Number(response.headers.get("content-length"));
    const body = await response
      .arrayBuffer()
      .then((bytes) => ({
        kind: "complete" as const,
        bytes: new Uint8Array(bytes),
      }))
      .catch(() => ({ kind: "incomplete" as const }));
    return { advertised, body };
  } finally {
    await server.stop(true);
  }
}

test("a file replaced after its headers are decided is sent as the version they describe", async () => {
  const { advertised, body } = await overHttp(async (file) => {
    await writeFile(`${file}.new`, Buffer.alloc(1 << 20, 66));
    await rename(`${file}.new`, file);
  });
  expect(advertised).toBe(4 << 20);
  if (body.kind !== "complete") throw new Error("Expected the whole download.");
  expect(body.bytes.length).toBe(4 << 20);
  expect(body.bytes.every((byte) => byte === 65)).toBe(true);
});

test("a file grown after its headers are decided sends exactly what they describe", async () => {
  const { advertised, body } = await overHttp((file) =>
    appendFile(file, Buffer.alloc(1 << 20, 66)),
  );
  expect(advertised).toBe(4 << 20);
  if (body.kind !== "complete") throw new Error("Expected the whole download.");
  expect(body.bytes.length).toBe(4 << 20);
  expect(body.bytes.every((byte) => byte === 65)).toBe(true);
});

test("a file truncated after its headers are decided never sends a length that does not match its bytes", async () => {
  const { advertised, body } = await overHttp((file) =>
    truncate(file, 1 << 20),
  );
  // Shortened in place: the server sends what remains, with that length.
  if (body.kind !== "complete")
    throw new Error("Expected the shortened download.");
  expect(body.bytes.length).toBe(advertised);
  expect(advertised).toBe(1 << 20);
  expect(body.bytes.every((byte) => byte === 65)).toBe(true);
});

test("ranges through the server send exactly the requested bytes with matching headers", async () => {
  const access = await admin();
  const file = path.join(root, "docs/ranged.bin");
  await writeFile(
    file,
    Uint8Array.from({ length: 3 << 20 }, (_, index) => index % 251),
  );
  const server = Bun.serve({
    port: 0,
    fetch: (request) => serveFile(request, "docs/ranged.bin", access),
  });
  try {
    const response = await fetch(`http://localhost:${server.port}/`, {
      headers: { Range: "bytes=1048576-2097151" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(
      `bytes 1048576-2097151/${3 << 20}`,
    );
    expect(response.headers.get("content-length")).toBe(String(1 << 20));
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(1 << 20);
    expect(bytes[0]).toBe(1048576 % 251);
    expect(bytes.at(-1)).toBe(2097151 % 251);
    const whole = await fetch(`http://localhost:${server.port}/`);
    expect(whole.headers.get("content-length")).toBe(String(3 << 20));
    expect((await whole.arrayBuffer()).byteLength).toBe(3 << 20);
  } finally {
    await server.stop(true);
  }
});

test("zero-copy is chosen only while the path names the opened file, unchanged", async () => {
  const file = path.join(root, "docs/checked.bin");
  const changes: [string, () => Promise<unknown>][] = [
    ["unchanged", async () => undefined],
    [
      "replaced",
      async () => {
        await writeFile(`${file}.new`, "BB");
        await rename(`${file}.new`, file);
      },
    ],
    ["truncated", () => truncate(file, 1)],
    ["grown", () => appendFile(file, "more")],
    ["touched", () => utimes(file, new Date(), new Date(Date.now() + 5000))],
  ];
  for (const [name, change] of changes) {
    await writeFile(file, "AAAA");
    const handle = await open(file, "r");
    try {
      // The headers are built from the open file's stats.
      const described = await handle.stat();
      await change();
      expect({ name, zeroCopy: await stillNamed(file, described) }).toEqual({
        name,
        zeroCopy: name === "unchanged",
      });
    } finally {
      await handle.close();
    }
  }
});

test("serves a stored version payload with its length, its download name and ranges", async () => {
  const payload = path.join(root, ".nimbus/versions/payload");
  await mkdir(path.dirname(payload), { recursive: true });
  await writeFile(payload, "0123456789");
  const whole = await serveStoredFile(get(), payload, "a (2026-11-16).txt");
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-length")).toBe("10");
  expect(whole.headers.get("content-type")).toBe("application/octet-stream");
  // RFC 8187 allows no unescaped parentheses in `filename*`; browsers drop a malformed one.
  expect(whole.headers.get("content-disposition")).toBe(
    `attachment; filename="a (2026-11-16).txt"; filename*=UTF-8''a%20%282026-11-16%29.txt`,
  );
  expect(await whole.text()).toBe("0123456789");
  const range = await serveStoredFile(
    get({ range: "bytes=2-4" }),
    payload,
    "a.txt",
  );
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 2-4/10");
  expect(range.headers.get("content-length")).toBe("3");
  expect(await range.text()).toBe("234");
  expect(
    (await serveStoredFile(get({ range: "bytes=20-" }), payload, "a.txt"))
      .status,
  ).toBe(416);
});

/** Descriptors this process holds open on `file`. */
function openDescriptors(file: string) {
  return readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === file;
    } catch {
      return false;
    }
  }).length;
}

test("small downloads close their descriptor before the response is returned", async () => {
  const access = await admin();
  const responses = await Promise.all(
    Array.from({ length: 200 }, () => serveFile(get(), "docs/a.txt", access)),
  );
  // Read into memory and closed while serving, not when the body is sent.
  expect(openDescriptors(path.join(root, "docs/a.txt"))).toBe(0);
  for (const response of responses)
    expect(await response.text()).toBe("0123456789");
});

test("zero-copy downloads hold at most the cap of descriptors, and release them", async () => {
  const access = await admin();
  const large = path.join(root, "docs/large.bin");
  await writeFile(large, Buffer.alloc(1 << 20, 65));
  // Earlier tests' holds would otherwise share the cap.
  await releaseHeldDescriptorsForTest();
  // Every request decides at once: none may pass the cap while another's check awaits.
  const burst = await Promise.all(
    Array.from({ length: maxHeldDescriptors + 100 }, () =>
      serveFile(get(), "docs/large.bin", access),
    ),
  );
  expect(heldDescriptorCount()).toBe(maxHeldDescriptors);
  // Downloads past the cap stream from their descriptor and close it when cancelled or done.
  const streamed = burst.length - maxHeldDescriptors;
  expect(openDescriptors(large)).toBe(maxHeldDescriptors + streamed);
  await Promise.all(burst.map((response) => response.body?.cancel()));
  await releaseHeldDescriptorsForTest();
  expect(heldDescriptorCount()).toBe(0);
  // Stream descriptors close asynchronously after cancellation; wait for that, not a time.
  while (openDescriptors(large) > 0) await Bun.sleep(5);
  // Freed slots are available again.
  const next = await serveFile(get(), "docs/large.bin", access);
  expect(heldDescriptorCount()).toBe(1);
  await next.body?.cancel();
  await releaseHeldDescriptorsForTest();
});

test("names the served file's version, which a replacement with the same size and modification time does not share", async () => {
  const access = await admin();
  const file = path.join(root, "docs/a.txt");
  const when = new Date(1_700_000_000_000);
  await utimes(file, when, when);
  const first = await serveFile(get(), "docs/a.txt", access);
  await writeFile(`${file}.next`, "9876543210");
  await rename(`${file}.next`, file);
  await utimes(file, when, when);
  const second = await serveFile(get(), "docs/a.txt", access);
  // The public ETag cannot tell them apart; the version proofs are bound to can.
  expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
  expect(servedVersion(first)).not.toBeNull();
  expect(servedVersion(second)).not.toBe(servedVersion(first));
  expect(servedVersion(new Response("other"))).toBeNull();
  await first.body?.cancel();
  await second.body?.cancel();
  await releaseHeldDescriptorsForTest();
});

test("names files and folder archives so every browser saves them under their own name", async () => {
  const access = await admin();
  const name = "Dad's Café “Notes” (v2).pdf";
  await writeFile(path.join(root, "docs", name), "%PDF-1.4");
  const encoded =
    "Dad%27s%20Caf%C3%A9%20%E2%80%9CNotes%E2%80%9D%20%28v2%29.pdf";
  // An ASCII `filename` for clients without RFC 8187, then the exact name in `filename*`.
  const fallback = `filename="Dad's Cafe _Notes_ (v2).pdf"; filename*=UTF-8''${encoded}`;
  const inline = await serveFile(get(), `docs/${name}`, access, true);
  expect(inline.headers.get("content-disposition")).toBe(`inline; ${fallback}`);
  const attachment = await serveFile(get(), `docs/${name}`, access);
  expect(attachment.headers.get("content-disposition")).toBe(
    `attachment; ${fallback}`,
  );
  await mkdir(path.join(root, "Föld'er (x)"));
  const zip = await serveZip("Föld'er (x)", access);
  expect(zip.headers.get("content-disposition")).toBe(
    `attachment; filename="Fold'er (x).zip"; filename*=UTF-8''F%C3%B6ld%27er%20%28x%29.zip`,
  );
  await zip.body?.cancel();
});

test("a small body rewritten in place after its stats were read is not served as the version it was opened as", async () => {
  const access = await admin();
  const file = path.join(root, "docs/a.txt");
  const opened = await stat(file);
  // The rewrite lands after the open file was stated and before its bytes are read.
  const restore = await hookFileHandle("read", "before", 1, () =>
    writeFile(file, "9876543210"),
  );
  try {
    const served = await serveFile(get(), "docs/a.txt", access);
    expect(await served.text()).toBe("9876543210");
    // Neither the old version, which a proof could name, nor any other: the bytes are unconfirmed.
    expect(servedVersion(served)).toBeNull();
    expect(servedVersion(served)).not.toBe(FileVersion.of(opened));
  } finally {
    restore();
  }
});

test("a confirmed body rewritten in place while it is sent ends as failed after only the version's bytes", async () => {
  const access = await admin();
  const file = path.join(root, "docs/big.bin");
  const chunk = 1 << 20;
  await writeFile(file, new Uint8Array(3 * chunk).fill(1));
  const opened = await stat(file);
  // Rewritten after the first chunk was read and confirmed, before the second is read.
  const restore = await hookFileHandle("read", "before", 2, () =>
    writeFile(file, new Uint8Array(3 * chunk).fill(2)),
  );
  try {
    const served = await serveFile(
      get(),
      "docs/big.bin",
      access,
      false,
      () => "confirmed",
    );
    expect(servedVersion(served)).toBe(FileVersion.of(opened));
    const received: Uint8Array[] = [];
    const reader = served.body?.getReader();
    if (!reader) throw new Error("The confirmed response has no body.");
    const failed = await (async () => {
      try {
        for (
          let read = await reader.read();
          !read.done;
          read = await reader.read()
        )
          received.push(read.value);
        return false;
      } catch {
        return true;
      }
    })();
    expect(failed).toBe(true);
    const sent = Buffer.concat(received);
    expect(sent.length).toBeLessThan(3 * chunk);
    expect(sent.every((byte) => byte === 1)).toBe(true);
  } finally {
    restore();
  }
});

test("a confirmed body of an unchanged file is sent whole", async () => {
  const access = await admin();
  const file = path.join(root, "docs/big.bin");
  await writeFile(file, new Uint8Array(3 * (1 << 20) + 5).fill(7));
  const served = await serveFile(
    get({ range: "bytes=10-2097161" }),
    "docs/big.bin",
    access,
    false,
    () => "confirmed",
  );
  expect(served.status).toBe(206);
  const body = new Uint8Array(await served.arrayBuffer());
  expect(body.length).toBe(2097152);
  expect(body.every((byte) => byte === 7)).toBe(true);
});
