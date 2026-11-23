/**
 * The container's main process: runs Nimbus through the supervisor (supervisor.ts) so it can be
 * restarted or updated without closing its port. `bun server/supervisor/main.ts` from apps/web.
 *
 * Control: the Unix socket at NIMBUS_SUPERVISOR_SOCKET (see settings.ts), in a directory only
 * this user may enter, answers `GET /status` and `POST /handover[?release=<name>]`. Nothing
 * listens on the network for it; `bun server/supervisor/control.ts` talks to it. SIGHUP hands
 * over to a fresh server of the same release. SIGTERM and SIGINT drain every server within
 * NIMBUS_STOP_SECONDS and exit, as a container stop needs.
 */
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ServerRun } from "@nimbus/api/server-run";
import { PROTOCOL_VERSION, Protocol, WorkerEnv } from "./protocol";
import { parseSettings } from "./settings";
import { createSupervisor, type Release, type SpawnWorker } from "./supervisor";

const log = (line: string) => console.info(`[supervisor] ${line}`);

const settings = parseSettings(process.env);
if (!settings.ok) {
  for (const message of settings.messages)
    console.error(`Nimbus did not start: ${message}`);
  process.exit(1);
}
const { releasesDir, socketPath } = settings.value;

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

function release(name: string | null): Release | null {
  if (name === null || name === builtIn.name) return builtIn;
  if (!releasesDir || !/^[\w][\w.-]{0,63}$/.test(name)) return null;
  const root = path.join(releasesDir, name);
  return existsSync(path.join(root, "apps/web/server/start.ts"))
    ? { name, root }
    : null;
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
      [ServerRun.env.id]: run.id,
      [ServerRun.env.startedAt]: String(run.startedAt),
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
});

/**
 * Make the socket's directory, refusing one that someone else owns or others may enter: only
 * this user, and root, may reach the control socket.
 */
async function socketDirectory(): Promise<string | null> {
  const directory = path.dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    return `${directory} must be a directory owned by this user and closed to others (mode 700), so only this user and root reach the supervisor's control socket. Remove it or set NIMBUS_SUPERVISOR_SOCKET elsewhere.`;
  await rm(socketPath, { force: true });
  return null;
}

const refused = await socketDirectory();
if (refused) {
  console.error(`Nimbus did not start: ${refused}`);
  process.exit(1);
}

const started = await supervisor.start();
if (!started.ok) {
  console.error(started.error.message);
  process.exit(1);
}

const control = Bun.serve({
  unix: socketPath,
  async fetch(request, server) {
    // A handover answers once the new server listens, which can take its whole startup.
    server.timeout(request, 0);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status")
      return Response.json(supervisor.status());
    if (request.method === "POST" && url.pathname === "/handover") {
      const outcome = await supervisor.handover(
        url.searchParams.get("release"),
      );
      if (outcome.ok) return Response.json(outcome.value);
      return Response.json(outcome.error, {
        status:
          outcome.error.kind === "busy"
            ? 409
            : outcome.error.kind === "unknown-release"
              ? 404
              : 503,
      });
    }
    return new Response(
      "Use GET /status or POST /handover[?release=<name>].\n",
      {
        status: 404,
      },
    );
  },
});
await chmod(socketPath, 0o600);
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
