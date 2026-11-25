import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm } from "node:fs/promises";
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
import { publishRelease } from "../updates/release-installer";
import { PROTOCOL_VERSION } from "./protocol";
import {
  buildSignedRelease,
  repo,
  tearDown,
  web,
  writeBuiltInInfo,
} from "./updates-e2e-testing";

/**
 * What the real-process update tests share (updates-install.e2e.ts, updates-refusals.e2e.ts):
 * a supervisor of this checkout as build 100, a local update source, build 101 built and signed
 * as CI does it (scripts/release-bundle.ts, about 15 seconds), and helpers to make further builds
 * from it, publish them, place them in the store as root's copy would, and watch the supervisor.
 * Each file has a harness of its own.
 */
export const MiB = 1024 * 1024;
export const filmSize = 48 * MiB;
const secret = "updates-e2e-secret-0123456789abcdef0123456";

export const built = existsSync(path.join(web, "dist/index.html"));

const statusSchema = z.object({
  phase: z.string(),
  active: z.object({ release: z.string(), pid: z.number() }).nullable(),
});

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

export class UpdatesHarness {
  root = "";
  port = 0;
  origin = "";
  socket = "";
  supervisor: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  log = "";
  source: Server<undefined> | null = null;
  /** What the update source serves, by file name. */
  readonly published = new Map<string, Uint8Array<ArrayBuffer>>();
  privateKey: Uint8Array<ArrayBuffer> = new Uint8Array();
  cookie = "";
  private built101: {
    manifest: Manifest;
    archive: string;
    tree: string;
  } | null = null;

  /** Build 101, as the bundle builder made it, and its unpacked tree. */
  get bundle101() {
    if (!this.built101) throw new Error("Build 101 was not made yet.");
    return this.built101;
  }

  /** Add `line` to the supervisor's log, as a note for a failed run. */
  note(line: string) {
    this.log += `\n${line}\n`;
  }

  async waitFor<T>(what: string, check: () => Promise<T | null>, ms = 60_000) {
    const until = Date.now() + ms;
    for (;;) {
      const value = await check().catch(() => null);
      if (value !== null) return value;
      if (Date.now() > until)
        throw new Error(`Timed out waiting for ${what}.\n${this.log}`);
      await Bun.sleep(100);
    }
  }

  status = async () =>
    statusSchema.parse(await (await ControlClient.status(this.socket)).json());

  active = async () => (await this.status()).active?.release ?? null;

  private ask = () =>
    fetch(`${this.origin}/api/health`, { keepalive: false }).then(
      (response) => response.status,
    );

  health = async () => {
    try {
      return await this.ask();
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
      return this.ask();
    }
  };

  async sign(manifest: Manifest) {
    const bytes = ReleaseManifest.encode(manifest);
    return {
      bytes,
      signature: await ReleaseSignature.sign(
        this.privateKey,
        "test-key",
        bytes,
      ),
    };
  }

  /** Serve `manifest` as the channel's newest release, with `bundle` as its bundle's bytes. */
  async publish(manifest: Manifest, bundle: Uint8Array<ArrayBuffer>) {
    const { bytes, signature } = await this.sign(manifest);
    this.published.clear();
    this.published.set("manifest.json", bytes);
    this.published.set("manifest.sig", signature);
    this.published.set(manifest.bundle.file, bundle);
  }

  /** A copy of release tree `tree` as build `sequence`, archived, with its manifest. */
  async variant(
    sequence: number,
    tree: string,
    change?: (root: string) => Promise<void>,
  ) {
    const copy = path.join(this.root, `tree-${sequence}`);
    await rm(copy, { recursive: true, force: true });
    if (Bun.spawnSync(["cp", "-a", tree, copy]).exitCode !== 0)
      throw new Error(`Could not copy ${tree}.`);
    const info = await BuildInfo.read(path.join(copy, "apps/web"));
    if (!info.ok || !info.value)
      throw new Error("The bundle has no build-info.json.");
    await Bun.write(
      BuildInfo.file(path.join(copy, "apps/web")),
      BuildInfo.encode({ ...info.value, sequence }),
    );
    await change?.(copy);
    const file = `nimbus-edge-${sequence}.tar.gz`;
    const archive = path.join(this.root, file);
    const written = await BundleArchive.write(copy, archive);
    const digest = await ReleaseTree.digest(copy);
    // Archived, the copy is not needed again: teardown has less to remove.
    await rm(copy, { recursive: true, force: true });
    const manifest: Manifest = {
      ...this.bundle101.manifest,
      build: { ...this.bundle101.manifest.build, sequence },
      bundle: { file, ...written },
      tree: digest,
    };
    return {
      manifest,
      bytes: new Uint8Array(await Bun.file(archive).arrayBuffer()),
    };
  }

  startSupervisor(prefix: string[] = []) {
    this.log = "";
    const child = Bun.spawn(
      [...prefix, process.execPath, "server/supervisor/main.ts"],
      {
        cwd: web,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: String(this.port),
          BETTER_AUTH_URL: this.origin,
          BETTER_AUTH_SECRET: secret,
          NIMBUS_DATA_ROOT: path.join(this.root, "data"),
          NIMBUS_CONFIG_ROOT: path.join(this.root, "config"),
          NIMBUS_SUPERVISOR_SOCKET: this.socket,
          NIMBUS_READY_TIMEOUT_SECONDS: "20",
          // A stop in a test needs no long drain: teardown and restarts stop promptly.
          NIMBUS_STOP_SECONDS: "5",
          NIMBUS_UPDATE_SOURCE: `http://127.0.0.1:${this.source?.port ?? 0}/`,
          NIMBUS_TEST_RELEASE_KEYS_FILE: path.join(this.root, "keys.json"),
          // Unsigned releases a restart may name; a rollback must never pick one.
          NIMBUS_TEST_RELEASES_DIR: path.join(this.root, "test-releases"),
          // One user here; the split is tested in split.e2e.ts.
          NIMBUS_TEST_UPDATES_WITH_ONE_USER: "1",
          NIMBUS_TEST_STORE_DIR: path.join(this.root, "store"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const stream of [child.stdout, child.stderr])
      void (async () => {
        for await (const chunk of stream)
          this.log += new TextDecoder().decode(chunk);
      })();
    this.supervisor = child;
    return this.waitFor("the supervisor to serve", async () =>
      existsSync(this.socket) && (await this.status()).phase === "serving"
        ? true
        : null,
    );
  }

  /**
   * A download read at `bytesPerSecond` over its own socket, so the server is held back by TCP
   * as a player holds it, checking every byte. Settles with what arrived.
   */
  stream(url: string, bytesPerSecond: number) {
    const target = new URL(url);
    const cookie = this.cookie;
    return new Promise<{
      status: number;
      received: number;
      mismatches: number;
    }>((resolve) => {
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
    });
  }

  /**
   * The folders, keys and source, build 101 by the real bundle builder (unpacked once, so later
   * builds are copies of it), a supervisor serving the checkout as build 100, and an account.
   * With `film`, a 48 MiB file whose byte i is i % 251, for a download checked to its last byte.
   */
  async setUp({
    film = false,
    prepare,
  }: {
    film?: boolean;
    /** Run once build 101 exists and before the supervisor first starts. */
    prepare?: () => Promise<void>;
  } = {}) {
    this.root = await mkdtemp(
      path.join(
        existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir(),
        "nimbus-updates-",
      ),
    );
    const root = this.root;
    await mkdir(path.join(root, "data/films"), { recursive: true });
    await mkdir(path.join(root, "config"));
    // The update store, laid out as the image lays it out.
    await mkdir(path.join(root, "store/releases"), { recursive: true });
    await mkdir(path.join(root, "store/staging"), { mode: 0o750 });
    await chmod(root, 0o755);
    await chmod(path.join(root, "store"), 0o755);
    await chmod(path.join(root, "store/staging"), 0o750);
    await mkdir(path.join(root, "control"), { mode: 0o700 });
    this.socket = path.join(root, "control/control.sock");
    if (film) {
      const file = await open(path.join(root, "data/films/film.bin"), "w");
      const block = Buffer.alloc(251 * 4096);
      for (let index = 0; index < block.length; index++)
        block[index] = index % 251;
      for (let written = 0; written < filmSize; written += block.length)
        await file.write(block, 0, Math.min(block.length, filmSize - written));
      await file.close();
    }

    const key = await ReleaseSignature.generate("test-key");
    this.privateKey = key.privateKey;
    await Bun.write(
      path.join(root, "keys.json"),
      JSON.stringify({ keys: [key.trustEntry] }),
    );
    await chmod(path.join(root, "keys.json"), 0o644);
    const published = this.published;
    this.source = Bun.serve({
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
      this.privateKey,
    );
    const tree = path.join(root, "tree-101");
    await mkdir(tree);
    const unpacked = await BundleArchive.unpack(
      Bun.file(archive).stream(),
      tree,
    );
    if (!unpacked.ok) throw new Error(unpacked.error.message);
    this.built101 = { manifest, archive, tree };

    await prepare?.();
    this.port = await freePort();
    this.origin = `http://localhost:${this.port}`;
    await this.startSupervisor();
    const signedUp = await fetch(`${this.origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.origin },
      body: JSON.stringify({
        name: "Owner",
        email: "owner@example.test",
        password: "updates-password-0123456789",
      }),
      keepalive: false,
    });
    if (!signedUp.ok)
      throw new Error(`Signing up failed with ${signedUp.status}.`);
    this.cookie = signedUp.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }

  /**
   * Place `build` in the store as an install does, without a handover: unpacked into a staging
   * folder and published by the code root uses (publishRelease), checked as it would be.
   */
  async place(build: { manifest: Manifest; bytes: Uint8Array<ArrayBuffer> }) {
    const staging = await mkdtemp(path.join(this.root, "staging-"));
    await mkdir(path.join(staging, "release"));
    const unpacked = await BundleArchive.unpack(
      new Blob([build.bytes]).stream(),
      path.join(staging, "release"),
    );
    if (!unpacked.ok) throw new Error(unpacked.error.message);
    const trust = await ReleaseSignature.trustRoot(
      new Uint8Array(
        await Bun.file(path.join(this.root, "keys.json")).arrayBuffer(),
      ),
    );
    if (!trust.ok) throw new Error(trust.error.message);
    const { bytes, signature } = await this.sign(build.manifest);
    const placed = await publishRelease({
      staging,
      releases: path.join(this.root, "store/releases"),
      owner: process.getuid?.() ?? 0,
      manifest: bytes,
      signature,
      trust: trust.value,
      builtInRoot: repo,
      supervisorProtocol: PROTOCOL_VERSION,
    });
    await rm(staging, { recursive: true, force: true });
    if (!placed.ok) throw new Error(placed.error.message);
    return placed.name;
  }

  /** Stop everything, leaving nothing behind (see tearDown). */
  async tearDown() {
    // For a run that failed: the supervisor's own account of it.
    if (process.env.NIMBUS_E2E_SUPERVISOR_LOG)
      await Bun.write(process.env.NIMBUS_E2E_SUPERVISOR_LOG, this.log);
    await this.source?.stop(true);
    await rm(BuildInfo.file(web), { force: true });
    await tearDown({
      supervisor: this.supervisor,
      root: this.root || undefined,
    });
  }
}
