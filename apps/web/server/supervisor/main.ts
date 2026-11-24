/**
 * The container's main process: runs Nimbus through the supervisor (supervisor.ts) so it can be
 * restarted or updated without closing its port. `bun server/supervisor/main.ts` from apps/web.
 *
 * Control: the Unix socket at NIMBUS_SUPERVISOR_SOCKET (see settings.ts), in a directory only
 * this user may enter, answers `GET /status`, `POST /handover[?release=<name>]`, and for updates
 * (docs/updates.md) `GET /update`, `POST /update/check`, `POST /update/install` and
 * `POST /update/rollback`; handovers, installs and rollbacks are streamed (HandoverStream).
 * Nothing listens on the network for it; `bun server/supervisor/control.ts` talks to it. SIGHUP hands
 * over to a fresh server of the same release. SIGTERM and SIGINT drain every server within
 * NIMBUS_STOP_SECONDS and exit, as a container stop needs.
 */
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ServerRun } from "@nimbus/api/server-run";
import { InstallationLock } from "../installation-lock";
import { getConfigRoot } from "../storage-paths";
import { ControlSocket } from "./control-socket";
import { HandoverStream } from "./handover-stream";
import { BuildInfo } from "../updates/build-info";
import { TrustRoot } from "../updates/trust-root";
import { UpdateSource } from "../updates/update-source";
import { createUpdater, type RunInstaller } from "../updates/updater";
import { ReleaseDirectory } from "./release-directory";
import { PROTOCOL_VERSION, Protocol, WorkerEnv } from "./protocol";
import { parseSettings } from "./settings";
import { z } from "zod";
import {
  createSupervisor,
  type HandoverReport,
  type Release,
  type SpawnWorker,
} from "./supervisor";
import type { StreamError } from "./handover-stream";

const log = (line: string) => console.info(`[supervisor] ${line}`);

const settings = parseSettings(process.env);
if (!settings.ok) {
  for (const message of settings.messages)
    console.error(`Nimbus did not start: ${message}`);
  process.exit(1);
}
const { releasesDir, socketPath } = settings.value;
const readyTimeoutSeconds = settings.value.readyTimeoutMs / 1000;

// Without it, a connection still queued on the old server's listener when that closes is reset.
const migrate = await readFile(
  "/proc/sys/net/ipv4/tcp_migrate_req",
  "utf8",
).catch(() => null);
if (migrate?.trim() === "0")
  log(
    "net.ipv4.tcp_migrate_req is 0 here, so during a restart without downtime a connection that arrives just as the old server leaves the port can be reset; browsers and players usually retry, but a rare request may fail. Set it to 1 for this container (docker run --sysctl net.ipv4.tcp_migrate_req=1, or sysctls in Compose) so such connections go to the new server.",
  );

const startedRun = ServerRun.fromEnvironment({});
if (!startedRun.ok) throw new Error(startedRun.error.message);
const run = startedRun.run;

/** The release the supervisor was built with: this checkout or image. */
const builtIn: Release = {
  name: "built-in",
  root: path.resolve(import.meta.dir, "../../../.."),
};

const configRoot = getConfigRoot();
/** Installed releases (see docs/updates.md), and any an operator put there by hand. */
const releases = releasesDir ?? path.join(configRoot, "releases");
/** Signed releases verified for this handover, by name (see `prepare`). */
const prepared = new Map<string, Release>();
/** What the first server starts from: an installed release, or the built-in one. */
let startWith: Release = builtIn;

function release(
  name: string | null,
): { ok: true; release: Release } | { ok: false; reason: string } {
  if (name === null) return { ok: true, release: startWith };
  if (name === builtIn.name) {
    const checked = ReleaseDirectory.check(builtIn.root);
    return checked.ok ? { ok: true, release: builtIn } : checked;
  }
  const signed = prepared.get(name);
  if (signed) return { ok: true, release: signed };
  // One an operator placed in the releases folder by hand, which only root can.
  return ReleaseDirectory.resolve(releases, name);
}

const spawn: SpawnWorker = (request, onMessage) => {
  const child = Bun.spawn([process.execPath, "server/start.ts"], {
    cwd: path.join(request.release.root, "apps/web"),
    env: {
      ...process.env,
      [WorkerEnv.protocol]: String(PROTOCOL_VERSION),
      [WorkerEnv.release]: request.release.name,
      [WorkerEnv.predecessor]: request.predecessor ? "1" : "0",
      [WorkerEnv.previousAssets]: request.previousAssets.join(":"),
      [WorkerEnv.supervisorPid]: String(process.pid),
      [ServerRun.env.id]: run.id,
      [ServerRun.env.startedAt]: String(run.startedAt),
      [ServerRun.env.process]: request.processId,
    },
    stdio: ["ignore", "inherit", "inherit"],
    ipc(value) {
      const message = Protocol.parseWorkerMessage(value);
      if (message) onMessage(message);
      else
        log(
          `ignored a message from ${request.release.name} (pid ${child.pid}) it does not understand; the release and the supervisor may not match`,
        );
    },
  });
  return {
    pid: child.pid,
    send(message) {
      // A worker that already exited has nobody to tell.
      if (child.exitCode === null && child.signalCode === null)
        child.send(message);
    },
    kill: (signal) => child.kill(signal),
    exited: child.exited,
  };
};

const supervisor = createSupervisor({
  run,
  spawn,
  settings: settings.value,
  release,
  distOf: (of) => path.join(of.root, "apps/web/dist"),
  log,
  // What runs is recorded when it takes over, also when no request waits for it.
  onActive: (release) => void activated(release),
});

/**
 * Servers it runs share their port with `reusePort`, which the kernel would also allow another
 * Nimbus of this user to join, such as a second container on the host network: two independent
 * servers on one database. So the port must be free before the first server starts: a plain
 * listen, which any socket already on it refuses.
 */
function portInUse(): string | null {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    return `PORT must be a port from 1 to 65535 under the supervisor, which keeps one port across restarts; got ${process.env.PORT}.`;
  try {
    const probe = Bun.listen({
      hostname: "0.0.0.0",
      port,
      socket: { data: () => undefined },
    });
    probe.stop(true);
    return null;
  } catch (error) {
    return `Something already listens on port ${port} (${error instanceof Error ? error.message : String(error)}), possibly another Nimbus. Two servers on one port would serve the same data side by side, so this one did not start. Stop the other one or choose another PORT.`;
  }
}

// One supervisor per installation, for its whole life; see InstallationLock.
await mkdir(configRoot, { recursive: true });
const installation = InstallationLock.acquire(configRoot);
if (!installation.ok) {
  console.error(installation.error.message);
  process.exit(1);
}
// Servers a supervisor that died left behind still hold the port and the database.
const earlier = await InstallationLock.awaitLeases(configRoot);
if (!earlier.ok) {
  console.error(`Nimbus did not start: ${earlier.error.message}`);
  process.exit(1);
}

const refused = portInUse();
if (refused) {
  console.error(`Nimbus did not start: ${refused}`);
  process.exit(1);
}
const socket = await ControlSocket.prepare(socketPath);
if (!socket.ok) {
  console.error(`Nimbus did not start: ${socket.error.message}`);
  process.exit(1);
}

const build = await BuildInfo.read(path.join(builtIn.root, "apps/web"));
if (!build.ok) log(build.error.message);
const source = UpdateSource.fromEnvironment(
  process.env.NIMBUS_UPDATE_SOURCE,
  build.ok ? build.value : null,
);
if (!source.ok) log(`updates are off: ${source.message}`);

/** The installer process (installer.ts), so downloads and unpacking never run in here. */
const installerAnswer = z.union([
  z.object({ ok: z.literal(true), name: z.string() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
const runInstaller: RunInstaller = async (request) => {
  const child = Bun.spawn(
    [process.execPath, "server/supervisor/installer.ts"],
    {
      cwd: path.join(builtIn.root, "apps/web"),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  void child.stdin.write(JSON.stringify(request));
  void child.stdin.end();
  const [code, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  let value: unknown;
  try {
    value = JSON.parse(output.trim().split("\n").at(-1) ?? "");
  } catch {
    value = null;
  }
  const answer = installerAnswer.safeParse(value);
  return answer.success
    ? answer.data
    : {
        ok: false,
        message: `The installer exited with code ${code} without saying how it went. Nothing new runs; the releases folder holds at most an unfinished staging copy, removed at the next install.`,
      };
};

const updater = await createUpdater({
  releases,
  builtIn: { root: builtIn.root, build: build.ok ? build.value : null },
  source: source.ok
    ? source.value
    : { kind: "off", reason: `Updates are off: ${source.message}` },
  trust: await TrustRoot.load(builtIn.root),
  supervisorProtocol: PROTOCOL_VERSION,
  runInstaller,
  log,
});

/** Verify installed release `name` so the next handover may start it; null if it is not one. */
async function prepare(name: string) {
  const resolved = await updater.resolve(name);
  if (!resolved.ok) return resolved;
  prepared.set(name, { name, root: resolved.root });
  return resolved;
}

const chosen = await updater.startRelease();
if (chosen) {
  startWith = { name: chosen.name, root: chosen.root };
  prepared.set(chosen.name, startWith);
}

/** Record that `release` serves now: the built-in one, or a verified installed one. */
async function activated(release: Release) {
  if (release.name === builtIn.name) await updater.ran(null);
  else if (prepared.has(release.name)) await updater.ran(release.name);
}

const started = await supervisor.start();
if (!started.ok) {
  console.error(started.error.message);
  process.exit(1);
}

/**
 * Every control answer closes its connection, so none is left idle for a client to send its
 * next request on just as the server closes it (see ControlClient).
 */
const closing = { Connection: "close" };

const control = Bun.serve({
  unix: socketPath,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status")
      return Response.json(
        {
          ...supervisor.status(),
          readyTimeoutSeconds,
        },
        { headers: closing },
      );
    if (request.method === "POST" && url.pathname === "/handover") {
      // Streamed, a line every few seconds: a handover lasts as long as the new server's
      // startup, and Bun resets a Unix socket connection idle for 10 seconds.
      const release = url.searchParams.get("release");
      return streamed(release, handOver(release));
    }
    if (request.method === "GET" && url.pathname === "/update")
      return Response.json(updater.status(), { headers: closing });
    if (request.method === "POST" && url.pathname === "/update/check") {
      const checked = await updater.check();
      return Response.json(
        checked.ok ? checked.status : { error: checked.message },
        { status: checked.ok ? 200 : 503, headers: closing },
      );
    }
    if (request.method === "POST" && url.pathname === "/update/install")
      return streamed(null, oneAtATime("install", installUpdate));
    if (request.method === "POST" && url.pathname === "/update/rollback")
      return streamed(null, oneAtATime("rollback", rollBack));
    return new Response(
      "Use GET /status, POST /handover[?release=<name>], GET /update, or POST /update/check, /update/install or /update/rollback.\n",
      { status: 404, headers: closing },
    );
  },
});
await chmod(socketPath, 0o600);

function streamed(
  release: string | null,
  outcome: Promise<
    { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
  >,
) {
  return HandoverStream.respond(release, outcome, {
    status: () => supervisor.status(),
    readyTimeoutSeconds,
  });
}

/** Hand over to `name`, verifying it first if it is an installed release, and record it. */
async function handOver(
  name: string | null,
): Promise<
  { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
> {
  if (name !== null && name !== builtIn.name) await prepare(name);
  // Written before any server stops: a full restart may migrate for it before it is active.
  const managed = name !== null && prepared.has(name) ? name : null;
  if (managed) {
    const marked = await updater.markPending(managed);
    if (!marked.ok)
      return {
        ok: false,
        error: { kind: "update-failed", message: marked.message },
      };
  }
  const outcome = await supervisor.handover(name);
  if (!outcome.ok && managed) {
    const now = supervisor.status();
    if (now.phase === "serving" && now.active?.release !== managed)
      await updater.clearPending(managed);
  }
  return outcome;
}

/** The install or rollback under way, from its start through its handover. */
let updating: "install" | "rollback" | null = null;

/**
 * Run one install or rollback at a time, through to the end of its handover: a second request
 * meanwhile is told one is running, and never starts another installer beside it.
 */
async function oneAtATime(
  what: "install" | "rollback",
  run: () => Promise<
    { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
  >,
): Promise<
  { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
> {
  if (updating)
    return {
      ok: false,
      error: {
        kind: "busy",
        message: `An ${updating === "install" ? "update" : "rollback"} is already under way; wait until it has finished, then try again.`,
      },
    };
  updating = what;
  try {
    return await run();
  } finally {
    updating = null;
  }
}

/** Install what the last check offered, then hand over to it. */
async function installUpdate(): Promise<
  { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
> {
  const installed = await updater.install();
  if (!installed.ok)
    return {
      ok: false,
      error: { kind: "update-failed", message: installed.message },
    };
  const verified = await prepare(installed.name);
  if (!verified.ok)
    return {
      ok: false,
      error: { kind: "update-failed", message: verified.message },
    };
  const outcome = await handOver(installed.name);
  if (outcome.ok)
    await updater.prune(
      [supervisor.status().active, ...supervisor.status().draining].flatMap(
        (worker) => (worker ? [worker.release] : []),
      ),
    );
  return outcome;
}

/** Hand back to the release that ran before the current one. */
async function rollBack(): Promise<
  { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
> {
  const target = await updater.rollbackTarget();
  if (!target.ok)
    return {
      ok: false,
      error: { kind: "update-failed", message: target.message },
    };
  return handOver(target.name ?? builtIn.name);
}
log(`serving; control socket ${socketPath}`);

process.on("SIGHUP", () => {
  void supervisor.handover(null).then((outcome) => {
    if (!outcome.ok) log(`SIGHUP restart refused: ${outcome.error.message}`);
  });
});
let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log(`${signal}: draining every server, then exiting`);
  void supervisor
    .stop()
    .then(async () => {
      await control.stop(true);
      await rm(socketPath, { force: true });
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("The supervisor could not stop cleanly.", error);
      process.exit(1);
    });
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
