import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Server, Subprocess } from "bun";
import { z } from "zod";
import { BundleArchive } from "../updates/bundle-archive";
import { BuildInfo } from "../updates/build-info";
import {
  ReleaseManifest,
  type ReleaseManifest as Manifest,
} from "../updates/release-manifest";
import { ReleaseSignature } from "../updates/release-signature";
import { ReleaseTree } from "../updates/release-tree";
import { ControlClient } from "./control-client";
import {
  buildSignedRelease,
  web,
  writeBuiltInInfo,
} from "./updates-e2e-testing";

/**
 * In-app updates with real processes (see docs/updates.md): from the built-in release to a signed
 * bundle built by scripts/release-bundle.ts, while a film-sized download streams from the server
 * being replaced; then every failure an update can meet, each leaving the running server as it
 * was; a rollback; and a restart that keeps the installed release. Needs the built client
 * (`bun run build`); it builds its own bundle, which takes about a minute.
 */
const built = existsSync(path.join(web, "dist/index.html"));
const MiB = 1024 * 1024;
const filmSize = 48 * MiB;
const secret = "updates-e2e-secret-0123456789abcdef0123456";

let root: string;
let port: number;
let origin: string;
let socket: string;
let supervisor: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let log = "";
let source: Server<undefined>;
/** What the update source serves, by file name. */
const published = new Map<string, Uint8Array<ArrayBuffer>>();
let privateKey: Uint8Array<ArrayBuffer>;
let cookie = "";
let bundle101: { manifest: Manifest; archive: string; tree: string };

async function freePort() {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const chosen = probe.port;
  probe.stop(true);
  return chosen;
}

async function waitFor<T>(
  what: string,
  check: () => Promise<T | null>,
  ms = 60_000,
) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > until)
      throw new Error(`Timed out waiting for ${what}.\n${log}`);
    await Bun.sleep(100);
  }
}

const statusSchema = z.object({
  phase: z.string(),
  active: z.object({ release: z.string(), pid: z.number() }).nullable(),
});
const status = async () =>
  statusSchema.parse(await (await ControlClient.status(socket)).json());
const active = async () => (await status()).active?.release ?? null;
/**
 * Whether connections queued on a closing listener move to the next one (tcp_migrate_req), as on
 * a production host. Without it, a request that arrives just as the old server leaves the port is
 * reset, a known limit the supervisor warns about; then a reset is tried once more, and nothing
 * else is excused.
 */
const migrates =
  (
    await Bun.file("/proc/sys/net/ipv4/tcp_migrate_req")
      .text()
      .catch(() => "0")
  ).trim() === "1";
const ask = () =>
  fetch(`${origin}/api/health`, { keepalive: false }).then(
    (response) => response.status,
  );
const health = async () => {
  try {
    return await ask();
  } catch (error) {
    if (
      migrates ||
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ECONNRESET"
      )
    )
      throw error;
    return ask();
  }
};

async function sign(manifest: Manifest) {
  const bytes = ReleaseManifest.encode(manifest);
  return {
    bytes,
    signature: await ReleaseSignature.sign(privateKey, "test-key", bytes),
  };
}

/** Serve `manifest` as the channel's newest release, with `bundle` as its bundle's bytes. */
async function publish(manifest: Manifest, bundle: Uint8Array<ArrayBuffer>) {
  const { bytes, signature } = await sign(manifest);
  published.clear();
  published.set("manifest.json", bytes);
  published.set("manifest.sig", signature);
  published.set(manifest.bundle.file, bundle);
}

/** A copy of release tree `tree` as build `sequence`, archived, with its manifest. */
async function variant(
  sequence: number,
  tree: string,
  change?: (root: string) => Promise<void>,
) {
  const copy = path.join(root, `tree-${sequence}`);
  await rm(copy, { recursive: true, force: true });
  expect(Bun.spawnSync(["cp", "-a", tree, copy]).exitCode).toBe(0);
  const info = await BuildInfo.read(path.join(copy, "apps/web"));
  if (!info.ok || !info.value)
    throw new Error("The bundle has no build-info.json.");
  await Bun.write(
    BuildInfo.file(path.join(copy, "apps/web")),
    BuildInfo.encode({ ...info.value, sequence }),
  );
  await change?.(copy);
  const file = `nimbus-edge-${sequence}.tar.gz`;
  const archive = path.join(root, file);
  const written = await BundleArchive.write(copy, archive);
  const manifest: Manifest = {
    ...bundle101.manifest,
    build: { ...bundle101.manifest.build, sequence },
    bundle: { file, ...written },
    tree: await ReleaseTree.digest(copy),
  };
  return {
    manifest,
    bytes: new Uint8Array(await Bun.file(archive).arrayBuffer()),
  };
}

function startSupervisor(prefix: string[] = []) {
  log = "";
  const child = Bun.spawn(
    [...prefix, process.execPath, "server/supervisor/main.ts"],
    {
      cwd: web,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_SECRET: secret,
        NIMBUS_DATA_ROOT: path.join(root, "data"),
        NIMBUS_CONFIG_ROOT: path.join(root, "config"),
        NIMBUS_SUPERVISOR_SOCKET: socket,
        NIMBUS_READY_TIMEOUT_SECONDS: "20",
        NIMBUS_UPDATE_SOURCE: `http://127.0.0.1:${source.port}/`,
        NIMBUS_RELEASE_KEYS_FILE: path.join(root, "keys.json"),
        // One user here; the split is tested in users.e2e.test.ts.
        NIMBUS_UPDATES_WITH_ONE_USER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr])
    void (async () => {
      for await (const chunk of stream) log += new TextDecoder().decode(chunk);
    })();
  supervisor = child;
  return waitFor("the supervisor to serve", async () =>
    existsSync(socket) && (await status()).phase === "serving" ? true : null,
  );
}

/**
 * A download read at `bytesPerSecond` over its own socket, so the server is held back by TCP as
 * a player holds it, checking every byte. Settles with what arrived.
 */
function stream(url: string, bytesPerSecond: number) {
  const target = new URL(url);
  return new Promise<{ status: number; received: number; mismatches: number }>(
    (resolve) => {
      const connection = net.connect(Number(target.port), target.hostname);
      let head = Buffer.alloc(0);
      let body = false;
      let status = 0;
      let received = 0;
      let mismatches = 0;
      let budget = 0;
      const refill = setInterval(() => {
        budget = bytesPerSecond / 10;
        connection.resume();
      }, 100);
      const finish = () => {
        clearInterval(refill);
        resolve({ status, received, mismatches });
      };
      connection.on("connect", () =>
        connection.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
        ),
      );
      connection.on("data", (chunk: Buffer) => {
        let data = chunk;
        if (!body) {
          head = Buffer.concat([head, chunk]);
          const end = head.indexOf("\r\n\r\n");
          if (end === -1) return;
          status = Number(head.subarray(9, 12).toString());
          data = head.subarray(end + 4);
          body = true;
        }
        for (let index = 0; index < data.byteLength; index++)
          if (data[index] !== (received + index) % 251) mismatches++;
        received += data.byteLength;
        budget -= data.byteLength;
        if (budget <= 0) connection.pause();
      });
      connection.on("close", finish);
      connection.on("error", finish);
    },
  );
}

describe.skipIf(!built)("in-app updates with real processes", () => {
  beforeAll(async () => {
    root = await mkdtemp(
      path.join(
        existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(),
        "nimbus-updates-",
      ),
    );
    await mkdir(path.join(root, "data/films"), { recursive: true });
    await mkdir(path.join(root, "config"));
    await mkdir(path.join(root, "control"), { mode: 0o700 });
    socket = path.join(root, "control/control.sock");
    // A film whose byte i is i % 251, so every byte can be checked.
    const film = await open(path.join(root, "data/films/film.bin"), "w");
    const block = Buffer.alloc(251 * 4096);
    for (let index = 0; index < block.length; index++)
      block[index] = index % 251;
    for (let written = 0; written < filmSize; written += block.length)
      await film.write(block, 0, Math.min(block.length, filmSize - written));
    await film.close();

    const key = await ReleaseSignature.generate("test-key");
    privateKey = key.privateKey;
    await Bun.write(
      path.join(root, "keys.json"),
      JSON.stringify({ keys: [key.trustEntry] }),
    );
    await chmod(path.join(root, "keys.json"), 0o644);
    source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const body = published.get(new URL(request.url).pathname.slice(1));
        return body
          ? new Response(body)
          : new Response("not found", { status: 404 });
      },
    });

    // The built-in release: this checkout, as build 100; build 101 by the real bundle builder.
    await writeBuiltInInfo(100);
    const { manifest, archive } = await buildSignedRelease(
      root,
      101,
      privateKey,
    );
    // Unpacked once, so the other builds are copies of it.
    const tree = path.join(root, "tree-101");
    await mkdir(tree);
    const unpacked = await BundleArchive.unpack(
      Bun.file(archive).stream(),
      tree,
    );
    if (!unpacked.ok) throw new Error(unpacked.error.message);
    bundle101 = { manifest, archive, tree };

    port = await freePort();
    origin = `http://localhost:${port}`;
    await startSupervisor();
    const signedUp = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        name: "Owner",
        email: "owner@example.test",
        password: "updates-password-0123456789",
      }),
      keepalive: false,
    });
    expect(signedUp.ok).toBe(true);
    cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }, 240_000);

  afterAll(async () => {
    supervisor?.kill("SIGKILL");
    await supervisor?.exited;
    await source?.stop(true);
    await rm(BuildInfo.file(web), { force: true });
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("an update installs and takes over while a download streams to its end from the server it replaced", async () => {
    expect(await active()).toBe("built-in");
    await publish(
      bundle101.manifest,
      new Uint8Array(await Bun.file(bundle101.archive).arrayBuffer()),
    );
    const checked = await ControlClient.checkForUpdate(socket);
    expect(checked.status).toBe(200);
    const film = stream(
      `${origin}/api/files/download?path=films/film.bin`,
      4 * MiB,
    );
    await Bun.sleep(1_000);
    // A gentle poll on fresh connections throughout, ten a second.
    let polling = true;
    const answers: number[] = [];
    const poll = (async () => {
      while (polling) {
        answers.push(await health().catch(() => 0));
        await Bun.sleep(100);
      }
    })();
    const done = await ControlClient.update(socket, "install");
    expect(done?.ok).toBe(true);
    expect(await active()).toBe(
      ReleaseManifest.releaseName(bundle101.manifest),
    );
    const played = await film;
    polling = false;
    await poll;
    expect(played.status).toBe(200);
    expect(played.received).toBe(filmSize);
    expect(played.mismatches).toBe(0);
    expect(answers.length).toBeGreaterThan(10);
    expect(answers.filter((code) => code !== 200)).toEqual([]);
  }, 120_000);

  test("a manifest changed after signing, a bundle cut short, one needing a newer image and one never ready each leave the running release serving", async () => {
    const running = await active();

    // Changed after signing: the check refuses it.
    const later = await variant(103, bundle101.tree);
    await publish(later.manifest, later.bytes);
    const changed = published.get("manifest.json");
    if (!changed) throw new Error("nothing published");
    published.set(
      "manifest.json",
      new TextEncoder().encode(
        new TextDecoder()
          .decode(changed)
          .replace('"sequence": 103', '"sequence": 109'),
      ),
    );
    const tampered = await ControlClient.checkForUpdate(socket);
    expect(tampered.status).toBe(503);
    expect(JSON.stringify(await tampered.json())).toContain(
      "does not match its manifest",
    );
    expect(await active()).toBe(running);

    // Cut short in transit: the install refuses it before unpacking anything.
    await publish(
      later.manifest,
      later.bytes.slice(0, Math.floor(later.bytes.byteLength / 2)),
    );
    expect((await ControlClient.checkForUpdate(socket)).status).toBe(200);
    const cut = await ControlClient.update(socket, "install");
    expect(cut?.ok).toBe(false);
    if (cut && !cut.ok)
      expect(cut.error.message).toContain("cut short or changed");
    expect(await active()).toBe(running);
    expect(await health()).toBe(200);

    // Needs a newer image: reported, never installed.
    const needsImage: Manifest = {
      ...later.manifest,
      requires: { ...later.manifest.requires, bun: "9.9.9" },
    };
    await publish(needsImage, later.bytes);
    const reported = await ControlClient.checkForUpdate(socket);
    expect(JSON.stringify(await reported.json())).toContain(
      "needs-newer-image",
    );
    const refused = await ControlClient.update(socket, "install");
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok)
      expect(refused.error.message).toContain(
        "Pull ghcr.io/example/nimbus:edge",
      );
    expect(await active()).toBe(running);

    // Installs, but its server never gets ready: abandoned, and the running release serves on.
    const broken = await variant(104, bundle101.tree, async (copy) => {
      await Bun.write(
        path.join(copy, "apps/web/server/start.ts"),
        'process.on("disconnect", () => process.exit(0));\nprocess.on("message", () => process.exit(0));\nsetInterval(() => undefined, 1000);\n',
      );
    });
    await publish(broken.manifest, broken.bytes);
    expect((await ControlClient.checkForUpdate(socket)).status).toBe(200);
    const never = await ControlClient.update(socket, "install");
    expect(never?.ok).toBe(false);
    if (never && !never.ok) expect(never.error.kind).toBe("not-ready");
    expect(await active()).toBe(running);
    expect(await health()).toBe(200);
  }, 180_000);

  test("a newer release installs, and a rollback returns to the one before", async () => {
    const before = await active();
    const next = await variant(105, bundle101.tree);
    await publish(next.manifest, next.bytes);
    expect((await ControlClient.checkForUpdate(socket)).status).toBe(200);
    // Asked twice at once: one install runs, through its handover; the other is told so.
    const both = await Promise.all([
      ControlClient.update(socket, "install"),
      ControlClient.update(socket, "install"),
    ]);
    expect(both.filter((done) => done?.ok)).toHaveLength(1);
    const turnedAway = both.find((done) => done && !done.ok);
    if (turnedAway && !turnedAway.ok)
      expect(turnedAway.error.kind).toBe("busy");
    expect(await active()).toBe(ReleaseManifest.releaseName(next.manifest));
    expect((await ControlClient.update(socket, "rollback"))?.ok).toBe(true);
    expect(await active()).toBe(before);
    expect(await health()).toBe(200);
  }, 120_000);

  test("after a restart the installed release runs again, and an install that runs out of space leaves it serving", async () => {
    const before = await active();
    supervisor?.kill("SIGTERM");
    expect(await supervisor?.exited).toBe(0);
    // Every file the supervisor and its processes write may grow to 8 MiB, less than a bundle.
    await startSupervisor(["prlimit", `--fsize=${8 * MiB}`, "--"]);
    expect(await active()).toBe(before);
    const next = await variant(106, bundle101.tree);
    await publish(next.manifest, next.bytes);
    expect((await ControlClient.checkForUpdate(socket)).status).toBe(200);
    const full = await ControlClient.update(socket, "install");
    expect(full?.ok).toBe(false);
    if (full && !full.ok)
      expect(full.error.message).toContain(
        "full or limits how large a file may grow",
      );
    expect(await active()).toBe(before);
    expect(await health()).toBe(200);
    const left = await readdir(path.join(root, "config/supervisor/releases"));
    expect(left).not.toContain(ReleaseManifest.releaseName(next.manifest));
  }, 120_000);
  test("a damaged installed release is not started: the supervisor falls back to the built-in one", async () => {
    const damaged = await active();
    if (!damaged || damaged === "built-in")
      throw new Error("No installed release runs.");
    supervisor?.kill("SIGTERM");
    expect(await supervisor?.exited).toBe(0);
    await Bun.write(
      path.join(
        root,
        "config/supervisor/releases",
        damaged,
        "apps/web/server/start.ts",
      ),
      "// replaced\n",
    );
    const started = performance.now();
    await startSupervisor();
    log += `\n(restart with a damaged release took ${Math.round(performance.now() - started)} ms)\n`;
    expect(await active()).toBe("built-in");
    expect(log).toContain("not the tree its signed manifest describes");
    expect(await health()).toBe(200);
  }, 120_000);
  test("once its key is no longer trusted, an installed release is never started, a rollback included", async () => {
    supervisor?.kill("SIGTERM");
    expect(await supervisor?.exited).toBe(0);
    // The image now trusts another key only, as after rotating a compromised one.
    const rotated = await ReleaseSignature.generate("rotated-key");
    await Bun.write(
      path.join(root, "keys.json"),
      JSON.stringify({ keys: [rotated.trustEntry] }),
    );
    await chmod(path.join(root, "keys.json"), 0o644);
    await startSupervisor();
    expect(await active()).toBe("built-in");
    const rolled = await ControlClient.update(socket, "rollback");
    expect(rolled?.ok).toBe(false);
    // Refused for its signature before anything of it starts, not tried and abandoned.
    if (rolled && !rolled.ok) {
      expect(rolled.error.kind).toBe("update-failed");
      expect(rolled.error.message).toContain("does not trust");
    }
    expect(await active()).toBe("built-in");
    expect(await health()).toBe(200);
  }, 120_000);
});
