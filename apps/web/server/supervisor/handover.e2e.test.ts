import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import { getAccess } from "@nimbus/api/access";
import { openDatabase } from "../db/connection";
import { createDriveStore } from "../drive-store";
import { DevicePairing } from "../libraries/device-pairing";
import { Libraries } from "../libraries/libraries";
import type { LibraryContext } from "../libraries/library-context";
import { PairedDevices } from "../libraries/paired-devices";

/**
 * The supervisor with real Nimbus servers: a film streamed before an update plays to its last
 * byte from the server that started it, while every new connection goes to the next server; a
 * device disconnected meanwhile is cut off on the draining server too; and a stop drains and
 * exits. Needs the built client (`bun run build`); CI runs it after the build.
 */
const web = path.resolve(import.meta.dir, "../..");
const built = existsSync(path.join(web, "dist/index.html"));
const MiB = 1024 * 1024;
const filmSize = 48 * MiB + 77;
/** Byte i of the film is i % 251, so any byte can be checked for where it came from. */
const patternByte = (offset: number) => offset % 251;

let root: string;
let port: number;
let origin: string;
let socket: string;
let supervisor: Subprocess<"ignore", "pipe", "inherit" | "pipe">;
let log = "";
const secret = "e2e-secret-0123456789abcdef0123456789abcdef";

async function freePort() {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const chosen = server.port;
  server.stop(true);
  return chosen;
}

async function writeFilm(file: string) {
  const block = Buffer.alloc(251 * 4096);
  for (let index = 0; index < block.length; index++)
    block[index] = patternByte(index);
  const handle = await open(file, "w");
  for (let written = 0; written < filmSize; written += block.length)
    await handle.write(block, 0, Math.min(block.length, filmSize - written));
  await handle.close();
}

const statusSchema = z.object({
  phase: z.string(),
  active: z.object({ pid: z.number() }).nullable(),
  draining: z.array(
    z.object({
      pid: z.number(),
      reason: z.string(),
      inFlight: z.number().nullable(),
    }),
  ),
});
const status = async () =>
  statusSchema.parse(
    await (await fetch("http://supervisor/status", { unix: socket })).json(),
  );

/** The pids holding a socket that listens on `port`, from /proc. */
async function listeners(onPort: number) {
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(table, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const local = fields[1];
      if (!local || fields[3] !== "0A") continue;
      if (Number.parseInt(local.split(":")[1] ?? "", 16) === onPort) {
        const inode = fields[9];
        if (inode) inodes.add(inode);
      }
    }
  }
  const pids = new Set<number>();
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const fds = await readdir(`/proc/${entry}/fd`).catch(() => []);
    for (const fd of fds) {
      const target = await readlink(`/proc/${entry}/fd/${fd}`).catch(() => "");
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && inodes.has(inode)) pids.add(Number(entry));
    }
  }
  return pids;
}

/**
 * A media player's request over a raw socket, reading at `bytesPerSecond` so the server is held
 * back by TCP as a playing film holds it, and checking every body byte against the pattern.
 * Decodes chunked bodies. Settles with what arrived, also when the connection is cut.
 */
function play(
  url: string,
  headers: Record<string, string>,
  bytesPerSecond: number,
) {
  const target = new URL(url);
  return new Promise<{
    status: number;
    length: number | null;
    chunked: boolean;
    received: number;
    mismatches: number;
    complete: boolean;
  }>((resolve) => {
    const socket = net.connect(Number(target.port), target.hostname);
    let head = Buffer.alloc(0);
    let headerDone = false;
    let status = 0;
    let length: number | null = null;
    let chunked = false;
    let received = 0;
    let mismatches = 0;
    let complete = false;
    // Chunked framing state: bytes left in the current chunk, and framing text buffered.
    let chunkLeft = 0;
    let framing = "";
    const started = performance.now();
    const body = (data: Buffer) => {
      for (const byte of data) {
        if (byte !== patternByte(received)) mismatches++;
        received++;
      }
    };
    const decodeChunked = (data: Buffer) => {
      let at = 0;
      while (at < data.length) {
        if (chunkLeft > 0) {
          const take = Math.min(chunkLeft, data.length - at);
          body(data.subarray(at, at + take));
          chunkLeft -= take;
          at += take;
          continue;
        }
        framing += String.fromCharCode(data[at] ?? 0);
        at++;
        const line = /^(?:\r\n)?([0-9a-fA-F]+)\r\n$/.exec(framing);
        if (line?.[1] !== undefined) {
          framing = "";
          chunkLeft = Number.parseInt(line[1], 16);
          if (chunkLeft === 0) complete = true;
        }
      }
    };
    socket.on("data", (data) => {
      if (!headerDone) {
        head = Buffer.concat([head, data]);
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        headerDone = true;
        const text = head.subarray(0, end).toString("latin1");
        status = Number(text.split(" ")[1]);
        const contentLength = /\r\ncontent-length: (\d+)/i.exec(text)?.[1];
        length = contentLength === undefined ? null : Number(contentLength);
        chunked = /\r\ntransfer-encoding: chunked/i.test(text);
        data = head.subarray(end + 4);
      }
      if (chunked) decodeChunked(data);
      else {
        body(data);
        if (length !== null && received >= length) complete = true;
      }
      if (complete) return socket.end();
      // Pace like a player: pause until this many bytes are due.
      const ahead =
        (received / bytesPerSecond) * 1000 - (performance.now() - started);
      if (ahead > 0) {
        socket.pause();
        setTimeout(() => socket.resume(), ahead);
      }
    });
    const settle = () =>
      resolve({ status, length, chunked, received, mismatches, complete });
    socket.on("close", settle);
    socket.on("error", () => undefined);
    const extra = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    socket.write(
      `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n${extra}Connection: close\r\n\r\n`,
    );
  });
}

async function waitFor<T>(
  what: string,
  check: () => Promise<T | null>,
  ms = 20_000,
) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > until)
      throw new Error(`Timed out waiting for ${what}.\n${log}`);
    await Bun.sleep(50);
  }
}

/**
 * A request on a connection of its own. Bun's fetch would reuse a pooled keep-alive connection
 * even after the server closed it, and the old server closes its idle ones when it leaves the
 * port; clients that check an idle connection before reusing it, as browsers, Go, nginx and
 * OkHttp do, never send on one the server closed.
 */
const send = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, keepalive: false });

const handover = async () => {
  const response = await fetch("http://supervisor/handover", {
    method: "POST",
    unix: socket,
  });
  expect(response.status).toBe(200);
};

let device: { token: string; id: string; itemId: string };
let sessionCookie: string;

describe.skipIf(!built)("handover with real servers", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-handover-"));
    const dataRoot = path.join(root, "data");
    const configRoot = path.join(root, "config");
    await mkdir(path.join(dataRoot, "films"), { recursive: true });
    await writeFilm(path.join(dataRoot, "films", "Film.mp4"));
    port = await freePort();
    origin = `http://localhost:${port}`;
    socket = path.join(root, "control", "control.sock");
    supervisor = Bun.spawn([process.execPath, "server/supervisor/main.ts"], {
      cwd: web,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: secret,
        NIMBUS_DATA_ROOT: dataRoot,
        NIMBUS_CONFIG_ROOT: configRoot,
        NIMBUS_SUPERVISOR_SOCKET: socket,
        NIMBUS_READY_TIMEOUT_SECONDS: "60",
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    void (async () => {
      for await (const chunk of supervisor.stdout)
        log += new TextDecoder().decode(chunk);
    })();
    await waitFor("the supervisor to serve", async () =>
      existsSync(socket) &&
      (await status().catch(() => null))?.phase === "serving"
        ? true
        : null,
    );

    // The administrator, signed in over HTTP like a browser.
    const headers = { "content-type": "application/json", origin };
    const account = {
      email: "owner@example.test",
      password: "e2e-password-0123456789",
    };
    expect(
      (
        await send(`${origin}/api/auth/sign-up/email`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: "Owner", ...account }),
        })
      ).ok,
    ).toBe(true);
    const signedIn = await send(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify(account),
    });
    sessionCookie = signedIn.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    // A library and a paired device, made beside the servers on the database they share. The
    // library's folders are checked against this process's data root.
    const dataRootBefore = process.env.NIMBUS_DATA_ROOT;
    process.env.NIMBUS_DATA_ROOT = dataRoot;
    const database = openDatabase(path.join(configRoot, "db.sqlite"));
    const userId = z
      .object({ id: z.string() })
      .parse(database.sqlite.query("SELECT id FROM user").get()).id;
    let now = Date.now();
    const ctx: LibraryContext = {
      db: database.db,
      drive: createDriveStore(database.db),
      origin: { kind: "configured", origin },
      secret,
      now: () => now++,
      run: () => "setup",
      getSession: async () => ({
        userId,
        sessionId: "setup",
        impersonatedBy: null,
      }),
    };
    const library = await Libraries.create(
      ctx,
      await getAccess(ctx.drive, userId),
      false,
      { title: "Films", folders: ["films"] },
    );
    if (!library.ok) throw new Error(library.error.message);
    const started = DevicePairing.start(ctx, "Television", "192.0.2.10");
    if (!started.ok) throw new Error(started.error.message);
    const session = { userId, sessionId: "setup", impersonatedBy: null };
    const shown = await DevicePairing.review(
      ctx,
      session,
      started.value.pairingCode,
      "192.0.2.10",
    );
    if (!shown.ok) throw new Error(shown.error.message);
    await DevicePairing.decide(
      ctx,
      session,
      {
        pairingId: shown.value.pairingId,
        ticket: shown.value.ticket,
        decision: { kind: "approve", libraryId: library.value.id },
      },
      "192.0.2.10",
    );
    const polled = DevicePairing.poll(
      ctx,
      started.value.deviceCode,
      "192.0.2.10",
    );
    if (!polled.ok || polled.value.status !== "approved")
      throw new Error("The device was not approved.");
    const grant = PairedDevices.list(ctx, userId)[0];
    if (!grant) throw new Error("The device is not listed.");
    database.sqlite.close();
    if (dataRootBefore === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = dataRootBefore;
    const items = z
      .object({
        items: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .parse(
        await (
          await send(`${origin}/api/library/v1/library`, {
            headers: { authorization: `Bearer ${polled.value.token}` },
          })
        ).json(),
      );
    const film = items.items.find((item) => item.name === "Film.mp4");
    if (!film) throw new Error("The film is not in the library.");
    device = { token: polled.value.token, id: grant.id, itemId: film.id };
  }, 60_000);

  afterAll(async () => {
    supervisor?.kill("SIGKILL");
    await supervisor?.exited;
    await rm(root, { recursive: true, force: true });
  });

  /** A media address and its cookie, as a player gets them. */
  async function mediaAddress() {
    const response = await send(
      `${origin}/api/library/v1/items/${encodeURIComponent(device.itemId)}/stream`,
      { method: "POST", headers: { authorization: `Bearer ${device.token}` } },
    );
    expect(response.status).toBe(200);
    const { url } = z.object({ url: z.string() }).parse(await response.json());
    const cookie =
      (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { url, cookie };
  }

  test("films streamed before an update play to their last byte from the server that started them", async () => {
    const before = await status();
    const old = before.active?.pid;
    if (old === undefined) throw new Error("nothing serves");
    const address = await mediaAddress();
    // A ranged answer with an exact length, sent zero-copy, and a whole file sent in chunks.
    const ranged = play(
      address.url,
      { cookie: address.cookie, range: "bytes=0-" },
      12 * MiB,
    );
    const whole = play(address.url, { cookie: address.cookie }, 12 * MiB);
    await Bun.sleep(1_000);
    const handedAt = performance.now();
    await handover();
    const switched = performance.now() - handedAt;
    const after = await status();
    const next = after.active?.pid;
    if (next === undefined)
      throw new Error("nothing serves after the handover");
    expect(next).not.toBe(old);
    expect(after.draining.map((worker) => worker.pid)).toEqual([old]);
    // Only the next server listens now, so every new connection reaches it.
    expect([...(await listeners(port))]).toEqual([next]);
    for (let request = 0; request < 20; request++)
      expect(
        (
          await send(`${origin}/api/health`, {
            headers: { connection: "close" },
          })
        ).ok,
      ).toBe(true);
    const [rangedResult, wholeResult] = await Promise.all([ranged, whole]);
    expect(rangedResult).toEqual({
      status: 206,
      length: filmSize,
      chunked: false,
      received: filmSize,
      mismatches: 0,
      complete: true,
    });
    expect(wholeResult).toEqual({
      status: 200,
      length: null,
      chunked: true,
      received: filmSize,
      mismatches: 0,
      complete: true,
    });
    // Its responses done, the old server exits on its own.
    await waitFor("the old server to exit", async () =>
      (await status()).draining.length === 0 ? true : null,
    );
    console.info(`handover took ${Math.round(switched)} ms to answer`);
  }, 60_000);

  test("a device disconnected while its film streams from a draining server is cut off", async () => {
    const address = await mediaAddress();
    const stream = play(address.url, { cookie: address.cookie }, 2 * MiB);
    await Bun.sleep(1_000);
    await handover();
    expect((await status()).draining).toHaveLength(1);
    const revoked = await send(`${origin}/api/trpc/libraries.revokeDevice`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
        origin,
      },
      body: JSON.stringify({ id: device.id }),
    });
    expect(revoked.status).toBe(200);
    const cutAt = performance.now();
    const result = await stream;
    expect(performance.now() - cutAt).toBeLessThan(3_000);
    expect(result.complete).toBe(false);
    expect(result.mismatches).toBe(0);
    expect(result.received).toBeLessThan(filmSize);
    const after = await send(address.url, {
      headers: { cookie: address.cookie, range: "bytes=0-0" },
    });
    expect(after.status).toBe(401);
  }, 60_000);

  test("a second supervisor on the same installation refuses to start, even on another port", async () => {
    const second = Bun.spawn([process.execPath, "server/supervisor/main.ts"], {
      cwd: web,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(await freePort()),
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: secret,
        NIMBUS_DATA_ROOT: path.join(root, "data"),
        NIMBUS_CONFIG_ROOT: path.join(root, "config"),
        NIMBUS_SUPERVISOR_SOCKET: path.join(root, "control-2", "control.sock"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    expect(await second.exited).toBe(1);
    expect(await new Response(second.stderr).text()).toContain(
      "Another Nimbus server is using this installation",
    );
    expect((await status()).phase).toBe("serving");
  }, 60_000);

  test("a supervisor started after the last one died waits for the servers it left", async () => {
    const left = (await status()).active?.pid;
    if (!left) throw new Error("No server is active.");
    // Frozen, so it is still running, holding its lease, when the supervisor dies.
    process.kill(left, "SIGSTOP");
    supervisor.kill("SIGKILL");
    await supervisor.exited;
    const env = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: secret,
      NIMBUS_DATA_ROOT: path.join(root, "data"),
      NIMBUS_CONFIG_ROOT: path.join(root, "config"),
      NIMBUS_SUPERVISOR_SOCKET: socket,
      NIMBUS_READY_TIMEOUT_SECONDS: "60",
    };
    const next = Bun.spawn([process.execPath, "server/supervisor/main.ts"], {
      cwd: web,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let warnings = "";
    void (async () => {
      for await (const chunk of next.stderr)
        warnings += new TextDecoder().decode(chunk);
    })();
    void (async () => {
      for await (const chunk of next.stdout)
        log += new TextDecoder().decode(chunk);
    })();
    supervisor = next;
    await waitFor(
      "the new supervisor to wait for the server left behind",
      async () =>
        warnings.includes(`waiting for server processes ${left} `)
          ? true
          : null,
    );
    await Bun.sleep(500);
    expect([...(await listeners(port))]).toEqual([left]);
    // An operator stops it, as the warning says.
    process.kill(left, "SIGKILL");
    await waitFor(
      "the new supervisor to serve",
      async () =>
        (await status().catch(() => null))?.phase === "serving" ? true : null,
      60_000,
    );
    expect([...(await listeners(port))]).not.toContain(left);
    expect(
      (await readdir(path.join(root, "config", "leases"))).filter((name) =>
        name.includes(`.${left}.`),
      ),
    ).toEqual([]);
  }, 90_000);

  test("a stop drains every server and exits", async () => {
    supervisor.kill("SIGTERM");
    expect(await supervisor.exited).toBe(0);
    expect((await listeners(port)).size).toBe(0);
  }, 60_000);
});
