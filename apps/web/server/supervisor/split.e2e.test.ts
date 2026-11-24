import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import type { Server, Subprocess } from "bun";
import { z } from "zod";
import { BuildInfo } from "../updates/build-info";
import { ReleaseManifest } from "../updates/release-manifest";
import { ReleaseSignature } from "../updates/release-signature";
import { ControlClient } from "./control-client";
import {
  buildSignedRelease,
  repo,
  web,
  writeBuiltInInfo,
} from "./updates-e2e-testing";

/**
 * The user split (see docs/updates.md) with real processes, as far as a user namespace allows
 * without a container: the image's entrypoint runs as root of a namespace with mapped ids, with
 * PUID and PGID 2000, and starts the supervisor as 1100. Checked from inside that namespace:
 * which users and capabilities the supervisor and its servers have, the config root's layout,
 * that the servers' user cannot change what the supervisor installs, a restart, and an install.
 * Then, as a container started with --user, one user and updates off. The release keys are
 * bound over the built-in file inside the namespace, as an image built with a key has them.
 * Needs the built client and `unshare --map-auto`; CI sets NIMBUS_REQUIRE_SPLIT_TEST=1 so a
 * runner without them fails instead of skipping.
 */
const built = existsSync(path.join(web, "dist/index.html"));
const entrypoint = path.join(repo, "scripts/docker-entrypoint.sh");
const namespaces =
  Bun.spawnSync([
    "unshare",
    "--map-auto",
    "--map-root-user",
    "--mount",
    "sh",
    "-c",
    'd=$(mktemp -d) && touch "$d/a" "$d/b" && mount --bind "$d/a" "$d/b" && setpriv --reuid=2000 --regid=2000 --clear-groups true; s=$?; umount "$d/b" 2>/dev/null; rm -rf "$d"; exit $s',
  ]).exitCode === 0;
const required = process.env.NIMBUS_REQUIRE_SPLIT_TEST === "1";
const secret = "split-e2e-secret-0123456789abcdef01234567";

let root: string;
let port: number;
let origin: string;
let source: Server<undefined>;
const published = new Map<string, Uint8Array<ArrayBuffer>>();
let supervisor: Subprocess<"ignore", "pipe", "pipe"> | null = null;
let log = "";

/** Run `command` as root of the supervisor's namespaces. */
async function inside(command: string[]) {
  if (!supervisor) throw new Error("The supervisor is not running.");
  const child = Bun.spawn(
    ["nsenter", "-t", String(supervisor.pid), "-U", "-m", "--", ...command],
    {
      cwd: web,
      env: {
        PATH: process.env.PATH ?? "",
        NIMBUS_SUPERVISOR_SOCKET: path.join(root, "run/control.sock"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/** `script` as the servers' user, inside. */
const asServer = (script: string) =>
  inside([
    "setpriv",
    "--reuid=2000",
    "--regid=2000",
    "--clear-groups",
    "--",
    "sh",
    "-c",
    script,
  ]);

const control = (...args: string[]) =>
  inside([
    process.execPath,
    path.join(web, "server/supervisor/control.ts"),
    ...args,
  ]);

const statusSchema = z.object({
  phase: z.string(),
  active: z.object({ release: z.string(), pid: z.number() }).nullable(),
});
async function active() {
  const answer = await control("status");
  if (answer.code !== 0) throw new Error(answer.stderr);
  const parsed = statusSchema.parse(JSON.parse(answer.stdout));
  if (!parsed.active) throw new Error(`Nothing serves.\n${log}`);
  return parsed.active;
}

/** What `/proc/<pid>/status` says of `pid`'s users and capabilities, seen from inside. */
async function credentials(pid: number) {
  const read = await inside(["cat", `/proc/${pid}/status`]);
  const field = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(read.stdout)?.[1]?.trim();
  return {
    uid: field("Uid"),
    gid: field("Gid"),
    groups: field("Groups"),
    inheritable: field("CapInh"),
    permitted: field("CapPrm"),
    effective: field("CapEff"),
    ambient: field("CapAmb"),
    noNewPrivs: field("NoNewPrivs"),
  };
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
    await Bun.sleep(250);
  }
}

const health = () =>
  fetch(`${origin}/api/health`, { keepalive: false }).then((response) =>
    response.ok ? true : null,
  );

function capture(child: Subprocess<"ignore", "pipe", "pipe">) {
  log = "";
  for (const stream of [child.stdout, child.stderr])
    void (async () => {
      for await (const chunk of stream) log += new TextDecoder().decode(chunk);
    })();
}

const environment = (config: string, data: string, socket: string) => ({
  PATH: process.env.PATH ?? "",
  NODE_ENV: "production",
  PORT: String(port),
  BETTER_AUTH_URL: origin,
  BETTER_AUTH_SECRET: secret,
  NIMBUS_DATA_ROOT: data,
  NIMBUS_CONFIG_ROOT: config,
  NIMBUS_SUPERVISOR_SOCKET: socket,
  NIMBUS_READY_TIMEOUT_SECONDS: "20",
  NIMBUS_UPDATE_SOURCE: `http://127.0.0.1:${source.port}/`,
});

const config = () => path.join(root, "config");
const installed = () => path.join(config(), "supervisor/releases");

describe.skipIf(!built || (!namespaces && !required))(
  "the user split with real processes",
  () => {
    let release101 = "";

    beforeAll(async () => {
      if (!namespaces)
        throw new Error(
          "This machine gives no user namespace with mapped ids (`unshare --map-auto --map-root-user --mount`), so the user split cannot be tested here; NIMBUS_REQUIRE_SPLIT_TEST=1 asks for it. Give the user subordinate ids (/etc/subuid, /etc/subgid) and allow unprivileged user namespaces.",
        );
      root = await mkdtemp("/var/tmp/nimbus-split-");
      // The supervisor's and the servers' users reach it, as they reach a container's volumes.
      await chmod(root, 0o755);
      await mkdir(path.join(root, "data"));
      const key = await ReleaseSignature.generate("test-key");
      await Bun.write(
        path.join(root, "keys.json"),
        JSON.stringify({ keys: [key.trustEntry] }),
      );
      await chmod(path.join(root, "keys.json"), 0o644);
      await writeBuiltInInfo(100);
      const bundle = await buildSignedRelease(root, 101, key.privateKey);
      release101 = ReleaseManifest.releaseName(bundle.manifest);
      const signature = await Bun.file(
        path.join(path.dirname(bundle.archive), "manifest.sig"),
      ).arrayBuffer();
      published.set(
        "manifest.json",
        new Uint8Array(
          await Bun.file(
            path.join(path.dirname(bundle.archive), "manifest.json"),
          ).arrayBuffer(),
        ),
      );
      published.set("manifest.sig", new Uint8Array(signature));
      published.set(
        bundle.manifest.bundle.file,
        new Uint8Array(await Bun.file(bundle.archive).arrayBuffer()),
      );
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
      const probe = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data: () => undefined },
      });
      port = probe.port;
      probe.stop(true);
      origin = `http://localhost:${port}`;

      // Root of a new user and mount namespace: the release keys in place, a private /tmp, a
      // folder for the control socket that only the supervisor's user enters; then the image's
      // entrypoint, as a container starts it.
      const setup = [
        "set -e",
        `mount --bind "${path.join(root, "keys.json")}" "${path.join(web, "release-keys.json")}"`,
        "mount -t tmpfs tmpfs /tmp",
        `mkdir -m 700 "${path.join(root, "run")}"`,
        `chown 1100:1100 "${path.join(root, "run")}"`,
        'exec sh "$0" "$@"',
      ].join("\n");
      const child = Bun.spawn(
        [
          "unshare",
          "--map-auto",
          "--map-root-user",
          "--mount",
          "sh",
          "-c",
          setup,
          entrypoint,
          process.execPath,
          "server/supervisor/main.ts",
        ],
        {
          cwd: web,
          env: {
            ...environment(
              config(),
              path.join(root, "data"),
              path.join(root, "run/control.sock"),
            ),
            PUID: "2000",
            PGID: "2000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      supervisor = child;
      capture(child);
      await waitFor("the split supervisor to serve", health);
    }, 240_000);

    afterAll(async () => {
      if (supervisor && supervisor.exitCode === null) {
        await inside(["kill", "-KILL", String(supervisor.pid)]);
        await supervisor.exited;
      }
      await source?.stop(true);
      await Bun.file(BuildInfo.file(web))
        .delete()
        .catch(() => undefined);
      // Files the namespace's users own are removed from inside one.
      if (root)
        Bun.spawnSync([
          "unshare",
          "--map-auto",
          "--map-root-user",
          "rm",
          "-rf",
          root,
        ]);
    });

    test("the supervisor runs as its own user able only to start and stop servers, which run as PUID:PGID with nothing more", async () => {
      expect(await credentials(supervisor?.pid ?? 0)).toEqual({
        uid: "1100\t1100\t1100\t1100",
        gid: "1100\t1100\t1100\t1100",
        groups: "",
        inheritable: "00000000000000e0",
        permitted: "00000000000000e0",
        effective: "00000000000000e0",
        ambient: "00000000000000e0",
        noNewPrivs: "1",
      });
      const server = await active();
      expect(server.release).toBe("built-in");
      expect(await credentials(server.pid)).toEqual({
        uid: "2000\t2000\t2000\t2000",
        gid: "2000\t2000\t2000\t2000",
        groups: "",
        inheritable: "0000000000000000",
        permitted: "0000000000000000",
        effective: "0000000000000000",
        ambient: "0000000000000000",
        noNewPrivs: "1",
      });
      expect(log).not.toContain("In-app updates are off");
    });

    test("the config root is shared without letting the servers' user replace what the supervisor owns", async () => {
      const layout = await inside([
        "stat",
        "-c",
        "%u:%g:%a",
        config(),
        path.join(config(), "supervisor"),
        installed(),
        path.join(config(), "server.lock"),
      ]);
      expect(layout.stdout.trim().split("\n")).toEqual([
        "0:2000:1771",
        "1100:1100:755",
        "1100:1100:755",
        "1100:2000:660",
      ]);
      for (const attempt of [
        `touch "${installed()}/planted"`,
        `mkdir "${installed()}/edge-999-aaaaaaaaaaaa"`,
        `mv "${config()}/supervisor" "${config()}/elsewhere"`,
        `rm -f "${config()}/server.lock"`,
      ])
        expect((await asServer(attempt)).code).not.toBe(0);
    });

    test("a restart and an install run their servers as PUID:PGID, and the installed release is the supervisor's alone", async () => {
      const before = await active();
      const restarted = await control("restart");
      expect(restarted.code).toBe(0);
      const after = await active();
      expect(after.pid).not.toBe(before.pid);
      expect((await credentials(after.pid)).uid).toBe("2000\t2000\t2000\t2000");

      expect((await control("update", "check")).code).toBe(0);
      const install = await control("update", "install");
      expect(install.code).toBe(0);
      const updated = await active();
      expect(updated.release).toBe(release101);
      expect((await credentials(updated.pid)).uid).toBe(
        "2000\t2000\t2000\t2000",
      );
      const tree = path.join(installed(), release101);
      expect(
        (await inside(["readlink", `/proc/${updated.pid}/cwd`])).stdout.trim(),
      ).toBe(path.join(tree, "apps/web"));
      expect((await inside(["stat", "-c", "%u", tree])).stdout.trim()).toBe(
        "1100",
      );
      for (const attempt of [
        `echo changed >> "${tree}/apps/web/server/start.ts"`,
        `rm -rf "${tree}"`,
        `mv "${tree}" "${installed()}/moved"`,
      ])
        expect((await asServer(attempt)).code).not.toBe(0);
      expect(await health()).toBe(true);
    }, 180_000);

    test("as under --user, everything runs as one user, still serving, with updates off and said why once", async () => {
      await inside(["kill", "-TERM", String(supervisor?.pid ?? 0)]);
      await supervisor?.exited;
      const single = path.join(root, "single");
      await mkdir(path.join(single, "config"), { recursive: true });
      await mkdir(path.join(single, "data"));
      await mkdir(path.join(single, "run"), { mode: 0o700 });
      const socket = path.join(single, "run/control.sock");
      const child = Bun.spawn([process.execPath, "server/supervisor/main.ts"], {
        cwd: web,
        env: environment(
          path.join(single, "config"),
          path.join(single, "data"),
          socket,
        ),
        stdio: ["ignore", "pipe", "pipe"],
      });
      supervisor = null;
      capture(child);
      try {
        await waitFor("the one-user supervisor to serve", health);
        expect(log.split("In-app updates are off").length - 1).toBe(1);
        expect(log).toContain("PUID and PGID");
        const status = z
          .object({ unavailable: z.string().nullable() })
          .parse(await (await ControlClient.updateStatus(socket)).json());
        expect(status.unavailable).toContain("PUID and PGID");
      } finally {
        child.kill("SIGTERM");
        await child.exited;
      }
    }, 120_000);
  },
);
