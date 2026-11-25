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
import { existsSync, readFileSync } from "node:fs";
import { chmod, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ServerRun } from "@nimbus/api/server-run";
import { ControlSocket } from "./control-socket";
import { HandoverStream } from "./handover-stream";
import { BuildInfo } from "../updates/build-info";
import { TrustRoot } from "../updates/trust-root";
import { UpdateSource } from "../updates/update-source";
import {
  BUILT_IN,
  createUpdater,
  type FetchManifest,
  type RunInstaller,
} from "../updates/updater";
import { publishRelease } from "../updates/release-installer";
import { UpdateStore } from "../updates/update-store";
import { Credentials, type Ids } from "./credentials";
import { ReleaseDirectory } from "./release-directory";
import {
  PROTOCOL_VERSION,
  Protocol,
  RELEASE_REFUSED_EXIT,
  WorkerEnv,
  type SupervisorMessage,
} from "./protocol";
import {
  UpdateRequestLimits,
  type UpdateOutcome,
  type UpdatePanel,
  type UpdateRequest,
} from "./update-protocol";
import { UpdateSchedule } from "../updates/update-schedule";
import type { HandoverEvent } from "./handover-stream";
import { parseSettings } from "./settings";
import { TestSeams } from "./test-seams";
import { Users } from "./users";
import { z } from "zod";
import {
  createSupervisor,
  type HandoverReport,
  type HandoverReservation,
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
const { socketPath } = settings.value;
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

// A fixed working folder the image owns, whatever the one it was started in: Bun reads a
// bunfig.toml from there.
process.chdir(path.join(builtIn.root, "apps/web"));

/** What tests inject from a source checkout; see TestSeams. */
const seams = TestSeams.fromEnvironment(process.env, builtIn.root);
if (seams.refused) log(seams.refused);
/** Who runs what, decided once (Users). */
const users = Users.fromEnvironment(process.env, {
  euid: process.geteuid?.() ?? -1,
  oneUserUpdates: seams.oneUserUpdates,
});
if (users.kind === "refused") {
  console.error(users.message);
  process.exit(1);
}
if (users.updatesOff) log(users.updatesOff);
/** The servers' ids when they have their own, which every server is checked to run as. */
const serverIds: Ids | null = users.kind === "split" ? users.server : null;
const updateIds: Ids | null = users.kind === "split" ? users.update : null;
const asServer = (command: string[]) =>
  serverIds ? Users.dropTo(serverIds, command) : command;
const asUpdateUser = (command: string[]) =>
  updateIds ? Users.dropTo(updateIds, command) : command;
const self = process.getuid?.() ?? -1;
/**
 * Installed releases (see docs/updates.md, The update store): only root writes them, only signed
 * ones, each copied and checked by root before it is published, and checked again before every
 * start.
 */
const store = UpdateStore.at(seams.storeDir ?? UpdateStore.image);
const releases = store.releases;
const storeChecked = await UpdateStore.check(store, {
  owner: users.kind === "split" ? 0 : self,
  update: updateIds?.uid ?? self,
});
if (!storeChecked.ok && !users.updatesOff) log(storeChecked.message);
/** Installed releases verified for the handover under way, by name (see `prepare`). */
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
  if (existsSync(path.join(releases, name)))
    return {
      ok: false,
      reason: `${name} is an installed release that has not been verified for this start`,
    };
  // Only tests in a source checkout start a release that is not installed.
  if (!seams.releasesDir)
    return { ok: false, reason: `there is no installed release ${name}` };
  return ReleaseDirectory.resolve(seams.releasesDir, name);
}

/** How to send each running server a message, by pid: for the audit of automatic updates. */
const workers = new Map<number, (message: SupervisorMessage) => void>();

/** Whether `release` is an installed one, which is verified again before every start. */
const installed = (release: Release) =>
  path.dirname(release.root) === path.resolve(releases);

/**
 * Start a server of `request.release`. An installed release is verified first, every time: a
 * first start, a handover, a restart after a crash or SIGHUP. With users of their own, the
 * server runs as PUID:PGID with nothing more, and is checked to: one that is not is stopped at
 * its first message, before the supervisor acts on anything it says.
 */
const spawn: SpawnWorker = (request, onMessage) => {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopped: NodeJS.Signals | null = null;
  const early: Parameters<ReturnType<SpawnWorker>["send"]>[0][] = [];
  /** The pid once the process exists; null when it never starts. */
  const launchedPid = Promise.withResolvers<number | null>();
  const exited = (async (): Promise<number | null> => {
    if (installed(request.release)) {
      const checking = performance.now();
      const verified = await updater.resolve(request.release.name);
      if (!verified.ok || verified.root !== request.release.root) {
        log(
          `did not start ${request.release.name}: ${verified.ok ? "it is not where it was verified" : verified.message}`,
        );
        launchedPid.resolve(null);
        return RELEASE_REFUSED_EXIT;
      }
      log(
        `verified ${request.release.name} in ${Math.round(performance.now() - checking)} ms before starting it`,
      );
    }
    // Earlier builds' assets the new server keeps serving: an installed one's verified again.
    const previousAssets: string[] = [];
    for (const dist of request.previousAssets) {
      const root = path.resolve(dist, "../../..");
      if (path.dirname(root) === path.resolve(releases)) {
        const earlier = await updater.resolve(path.basename(root));
        if (!earlier.ok || earlier.root !== root) {
          log(
            `not serving the assets of ${path.basename(root)} beside ${request.release.name}: ${earlier.ok ? "it is not where it was verified" : earlier.message}`,
          );
          continue;
        }
      }
      previousAssets.push(dist);
    }
    if (stopped) {
      launchedPid.resolve(null);
      return null;
    }
    let checked = serverIds === null;
    const started = Bun.spawn(asServer([process.execPath, "server/start.ts"]), {
      cwd: path.join(request.release.root, "apps/web"),
      // Their environment, explicitly: the supervisor's, with a home of their own as before.
      env: {
        ...process.env,
        HOME: "/tmp",
        [WorkerEnv.protocol]: String(PROTOCOL_VERSION),
        [WorkerEnv.release]: request.release.name,
        [WorkerEnv.predecessor]: request.predecessor ? "1" : "0",
        [WorkerEnv.previousAssets]: previousAssets.join(":"),
        [WorkerEnv.supervisorPid]: String(process.pid),
        [ServerRun.env.id]: run.id,
        [ServerRun.env.startedAt]: String(run.startedAt),
        [ServerRun.env.process]: request.processId,
      },
      stdio: ["ignore", "inherit", "inherit"],
      ipc(value) {
        if (!checked) {
          const wrong = serverIds
            ? Credentials.dropped(
                Credentials.parse(
                  readFileSync(`/proc/${started.pid}/status`, "utf8"),
                ),
                serverIds,
              )
            : null;
          if (wrong) {
            log(
              `stopped ${request.release.name} (pid ${started.pid}) without acting on it: ${wrong}, not ${serverIds?.uid}:${serverIds?.gid} with nothing more`,
            );
            started.kill("SIGKILL");
            return;
          }
          checked = true;
        }
        const message = Protocol.parseWorkerMessage(value);
        // Update requests are answered here, by the updater; the rest is the supervisor's.
        if (message?.kind === "update-request")
          void answerUpdate(
            (reply) => {
              if (started.exitCode === null && started.signalCode === null)
                started.send(reply);
            },
            message.id,
            message.request,
          );
        else if (message) onMessage(message);
        else
          log(
            `ignored a message from ${request.release.name} (pid ${started.pid}) it does not understand; the release and the supervisor may not match`,
          );
      },
    });
    child = started;
    launchedPid.resolve(started.pid);
    workers.set(started.pid, (reply) => {
      if (started.exitCode === null && started.signalCode === null)
        started.send(reply);
    });
    void started.exited.then(() => workers.delete(started.pid));
    for (const message of early.splice(0)) started.send(message);
    return started.exited;
  })();
  return {
    get pid() {
      return child?.pid ?? 0;
    },
    send(message) {
      // A worker that already exited has nobody to tell.
      if (!child) early.push(message);
      else if (child.exitCode === null && child.signalCode === null)
        child.send(message);
    },
    kill(signal) {
      if (child) child.kill(signal);
      else stopped = signal;
    },
    exited,
    started: launchedPid.promise,
  };
};

const supervisor = createSupervisor({
  run,
  spawn,
  settings: settings.value,
  release,
  distOf: (of) => path.join(of.root, "apps/web/dist"),
  builtIn,
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

// One supervisor per installation, for its whole life (see InstallationLock), held by a helper
// running as the servers' user, whose config root it is (installation.ts).
const installation = Bun.spawn(
  asServer([process.execPath, "server/supervisor/installation.ts"]),
  {
    cwd: path.join(builtIn.root, "apps/web"),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  },
);
{
  const reader = installation.stdout.getReader();
  let said = "";
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    said += new TextDecoder().decode(read.value);
    if (said.includes('{"held":true}')) break;
  }
  reader.releaseLock();
  if (!said.includes('{"held":true}')) {
    console.error(
      `Nimbus did not start: it could not hold its installation (the helper exited with ${await installation.exited}; its reason is above).`,
    );
    process.exit(1);
  }
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

/** The installer's answer: data, checked, never a path or a command. */
const installerAnswer = z.union([
  z.object({ ok: z.literal(true), name: z.string() }),
  z.object({
    ok: z.literal(true),
    manifest: z.base64().max(128 * 1024),
    signature: z.base64().max(8 * 1024),
  }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
/** At most this much of what the installer says is read, and of each line it logs. */
const INSTALLER_OUTPUT_BYTES = 256 * 1024;
const printable = (text: string, length: number) =>
  text.replace(/[^\x20-\x7e\u00a0-\uffff]/g, " ").slice(0, length);

/** Run installer.ts for `request`, as the update user, with only what it needs. */
async function installer(
  request:
    | {
        kind: "stage";
        source: string;
        manifest: string;
        signature: string;
      }
    | { kind: "clean" }
    | { kind: "fetch"; source: string },
): Promise<
  | { ok: true; answer: z.infer<typeof installerAnswer> }
  | { ok: false; message: string }
> {
  const child = Bun.spawn(
    asUpdateUser([
      process.execPath,
      path.join(builtIn.root, "apps/web/server/supervisor/installer.ts"),
    ]),
    {
      // A working folder the image owns, so no bunfig.toml it left in staging is read.
      cwd: path.join(builtIn.root, "apps/web"),
      // No secret of the application, no home, and staging for its temporary files.
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/nonexistent",
        TMPDIR: store.staging,
        NODE_ENV: "production",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        ...(seams.keysFile
          ? { [TestSeams.names.keysFile]: seams.keysFile }
          : {}),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const fail = (message: string) => ({ ok: false as const, message });
  if (updateIds) {
    // Checked before it is given anything to do: setpriv has run once it is no longer root.
    let wrong: string | null = "it did not start";
    for (let tries = 0; tries < 100 && child.exitCode === null; tries++) {
      const credentials = await Credentials.read(child.pid);
      if (credentials && !credentials.uids.includes(0)) {
        wrong = Credentials.dropped(credentials, updateIds);
        break;
      }
      await Bun.sleep(20);
    }
    if (wrong) {
      child.kill("SIGKILL");
      await child.exited;
      return fail(
        `The installer was not started as the update user with nothing more (${wrong}), so nothing was installed.`,
      );
    }
  }
  void child.stdin.write(
    JSON.stringify({ ...request, staging: store.staging }),
  );
  void child.stdin.end();
  const logged = (async () => {
    let text = "";
    for await (const chunk of child.stderr) {
      if (text.length < INSTALLER_OUTPUT_BYTES)
        text += new TextDecoder().decode(chunk);
    }
    for (const line of text.split("\n").filter(Boolean).slice(0, 50))
      log(`installer: ${printable(line, 300)}`);
  })();
  let output = "";
  for await (const chunk of child.stdout)
    if (output.length < INSTALLER_OUTPUT_BYTES)
      output += new TextDecoder().decode(chunk);
  const [code] = await Promise.all([child.exited, logged]);
  let value: unknown;
  try {
    value = JSON.parse(output.trim().split("\n").at(-1) ?? "");
  } catch {
    value = null;
  }
  const answer = installerAnswer.safeParse(value);
  if (!answer.success)
    return fail(
      `The installer exited with code ${code} without saying how it went. Nothing was installed.`,
    );
  return answer.data.ok
    ? { ok: true, answer: answer.data }
    : fail(printable(answer.data.message, 1000));
}

/**
 * Run the installer for `request`, then stop whatever of the update user is left, whatever came
 * of it: an installer leaves no process behind, even one that failed or was compromised.
 */
async function asUpdateUserOnce(request: Parameters<typeof installer>[0]) {
  try {
    return await installer(request);
  } finally {
    if (updateIds) {
      const stopped = await stopUpdateUser(updateIds);
      if (!stopped.ok) log(stopped.message);
    }
  }
}

/** The manifest and signature, fetched by the installer as the update user (see Updater). */
const fetchManifest: FetchManifest = async (source) => {
  const fetched = await asUpdateUserOnce({
    kind: "fetch",
    source: source.base.href,
  });
  if (!fetched.ok) return fetched;
  if (!("manifest" in fetched.answer))
    return { ok: false, message: "The installer did not send the manifest." };
  return {
    ok: true,
    manifest: new Uint8Array(Buffer.from(fetched.answer.manifest, "base64")),
    signature: new Uint8Array(Buffer.from(fetched.answer.signature, "base64")),
  };
};

/**
 * Stop every process of the update user, as root: once none is left, nothing can change the
 * staged tree while root copies it. Each pass signals them all at once from a process of that
 * user (`kill(-1)`, which the kernel applies in one sweep, so a process forking cannot slip
 * through), then waits and looks again; one left after ten passes fails the install.
 */
async function stopUpdateUser(
  ids: Ids,
): Promise<{ ok: true } | { ok: false; message: string }> {
  // At most ten passes, and never longer than ten seconds.
  const deadline = Date.now() + 10_000;
  for (let pass = 0; pass < 10 && Date.now() < deadline; pass++) {
    const left = await Credentials.processesOf(ids.uid);
    if (!left.length) return { ok: true };
    await Bun.spawn(
      Users.dropTo(ids, [
        process.execPath,
        "-e",
        "process.kill(-1, 'SIGKILL')",
      ]),
      {
        stdio: ["ignore", "ignore", "ignore"],
        env: { PATH: process.env.PATH ?? "" },
      },
    ).exited;
    await Bun.sleep(100);
  }
  const left = await Credentials.processesOf(ids.uid);
  return left.length
    ? {
        ok: false,
        message: `Processes of the update user (${left.join(", ")}) still ran after being stopped ten times, so nothing was published: what they staged could still change. Restart the container.`,
      }
    : { ok: true };
}

/**
 * Install as docs/updates.md describes: the installer stages the release as the update user;
 * root stops every process of that user, copies and checks the staged tree, and publishes it;
 * the installer then removes what it staged.
 */
const runInstaller: RunInstaller = async (request) => {
  const manifest = new Uint8Array(Buffer.from(request.manifest, "base64"));
  const signature = new Uint8Array(Buffer.from(request.signature, "base64"));
  const trust = await TrustRoot.load(builtIn.root, seams.keysFile);
  if (!trust.ok) return { ok: false, message: trust.message };
  try {
    const staged = await asUpdateUserOnce({
      kind: "stage",
      source: request.source,
      manifest: request.manifest,
      signature: request.signature,
    });
    if (!staged.ok) return staged;
    // Nothing of the update user may run while root reads what it staged.
    if (updateIds) {
      const stopped = await stopUpdateUser(updateIds);
      if (!stopped.ok) return stopped;
    }
    const published = await publishRelease({
      staging: store.staging,
      releases,
      owner: updateIds?.uid ?? self,
      manifest,
      signature,
      trust: trust.value,
      builtInRoot: builtIn.root,
      supervisorProtocol: PROTOCOL_VERSION,
    });
    return published.ok
      ? published
      : { ok: false, message: published.error.message };
  } finally {
    const cleaned = await asUpdateUserOnce({ kind: "clean" });
    if (!cleaned.ok)
      log(`could not remove the staged release: ${cleaned.message}`);
  }
};

const updater = await createUpdater({
  releases,
  storeOwner: users.kind === "split" ? 0 : self,
  // A store whose layout was refused gives nothing: the built-in release runs alone.
  untrusted: storeChecked.ok ? null : storeChecked.message,
  disabled: users.updatesOff ?? (storeChecked.ok ? null : storeChecked.message),
  builtIn: { root: builtIn.root, build: build.ok ? build.value : null },
  source: source.ok
    ? source.value
    : { kind: "off", reason: `Updates are off: ${source.message}` },
  trust: await TrustRoot.load(builtIn.root, seams.keysFile),
  supervisorProtocol: PROTOCOL_VERSION,
  runInstaller,
  fetchManifest,
  log,
});

/** Verify installed release `name` so the next handover may start it; null if it is not one. */
async function prepare(name: string) {
  const resolved = await updater.resolve(name);
  if (!resolved.ok) return resolved;
  prepared.set(name, { name, root: resolved.root });
  return resolved;
}

// The image's own build, recorded before anything serves (see Updater.recordFloor).
const floor = await updater.recordFloor();
if (!floor.ok) log(floor.message);
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
      return streamed(
        release,
        reserved((reservation) => handOver(targetOf(release), reservation)),
      );
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

/**
 * Run `step` holding the next handover (see HandoverReservation): when the supervisor is busy
 * the answer is busy at once, before anything was downloaded, reserved or written.
 */
async function reserved(
  step: (
    reservation: HandoverReservation,
  ) => Promise<
    { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
  >,
): Promise<
  { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
> {
  const reservation = supervisor.reserve();
  if (!reservation.ok) return reservation;
  try {
    return await step(reservation.value);
  } finally {
    reservation.value.release();
  }
}

/**
 * What a handover starts: the running release again, the image's built-in one, an installed one
 * (verified first, every time), or, in tests only, a release named from the test seam.
 */
type Target =
  | { kind: "same" }
  | { kind: "built-in" }
  | { kind: "installed"; name: string }
  | { kind: "named"; name: string };

/** What a restart naming `name`, or none, starts. */
function targetOf(name: string | null): Target {
  if (name === null) return { kind: "same" };
  if (name === builtIn.name) return { kind: "built-in" };
  return /^[\w][\w.-]{0,63}$/.test(name) &&
    existsSync(path.join(releases, name))
    ? { kind: "installed", name }
    : { kind: "named", name };
}

/** Hand over to `target`, verifying an installed release first and recording it. */
async function handOver(
  target: Target,
  reservation: HandoverReservation,
): Promise<
  { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
> {
  if (target.kind === "same") return supervisor.handover(null, reservation);
  if (target.kind === "built-in")
    return supervisor.handover(builtIn.name, reservation);
  if (target.kind === "named")
    return supervisor.handover(target.name, reservation);
  // With updates off (a damaged or unwritable state, one user), nothing installed is handed over
  // to by name or rolled back to: only what boot chose runs.
  const off = updater.blocked();
  if (off) return { ok: false, error: { kind: "update-failed", message: off } };
  // An installed release is verified again for every handover, and refused if it fails: never
  // started from an earlier check, and what was verified is what starts.
  const { name } = target;
  prepared.delete(name);
  const verified = await prepare(name);
  if (!verified.ok)
    return {
      ok: false,
      error: {
        kind: "update-failed",
        message: `Release ${name} was not started: ${verified.message}. Nothing was changed; the running release keeps serving.`,
      },
    };
  // Written before any server stops: a full restart may migrate for it before it is active.
  const marked = await updater.markPending(name);
  if (!marked.ok)
    return {
      ok: false,
      error: { kind: "update-failed", message: marked.message },
    };
  const outcome = await supervisor.handover(
    { name, root: verified.root },
    reservation,
  );
  // Busy after what it starts was written: the container is stopping. The record stays, so the
  // next start runs it, consistent with the build reserved for it.
  if (!outcome.ok && outcome.error.kind === "busy")
    return {
      ok: false,
      error: {
        kind: "update-failed",
        message: `Release ${name} is installed and recorded as the one to start, but the supervisor was stopping or not serving in time, so it was not started now; it starts when the container next starts.`,
      },
    };
  if (!outcome.ok) {
    const now = supervisor.status();
    if (now.phase === "serving" && now.active?.release !== name)
      await updater.clearPending(name);
  }
  return outcome;
}

/** The install or rollback under way, from its start through its handover. */
let updating: {
  kind: "install" | "rollback";
  by: UpdateOutcome["by"];
  startedAt: number;
  /** Who follows its progress: servers relaying it to an administrator's page. */
  listeners: Set<(event: HandoverEvent) => void>;
} | null = null;
/** How the last install or rollback ended, for the update page. */
let lastOutcome: UpdateOutcome | null = null;

/** Where the install or rollback under way is, as the update page shows it. */
function operationNow() {
  if (!updating) return null;
  const now = supervisor.status();
  return {
    kind: updating.kind,
    by: updating.by,
    startedAt: new Date(updating.startedAt).toISOString(),
    // Before its handover, an install downloads, verifies and publishes.
    stage: now.phase === "serving" ? "preparing" : now.phase,
    seconds: Math.round((Date.now() - updating.startedAt) / 1000),
    starting: now.starting
      ? { release: now.starting.release, pid: now.starting.pid }
      : null,
    readyTimeoutSeconds,
  };
}

/** The update page's state. */
function panel(): UpdatePanel {
  return {
    ...updater.status(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    operation: operationNow(),
    lastOutcome,
  };
}

/**
 * Run one install or rollback at a time, through to the end of its handover: a second request
 * meanwhile is told one is running, and never starts another installer beside it. Its progress
 * goes to `follow` and to everyone following it; its outcome is kept for the update page and, for
 * one the schedule started, recorded in the audit log by the active server.
 */
async function oneAtATime(
  what: "install" | "rollback",
  run: () => Promise<
    { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
  >,
  {
    by = "administrator",
    follow,
  }: {
    by?: UpdateOutcome["by"];
    follow?: (event: HandoverEvent) => void;
  } = {},
): Promise<
  { ok: true; value: HandoverReport } | { ok: false; error: StreamError }
> {
  if (updating)
    return {
      ok: false,
      error: {
        kind: "busy",
        message: `An ${updating.kind === "install" ? "update" : "rollback"} is already under way; wait until it has finished, then try again.`,
      },
    };
  const current = {
    kind: what,
    by,
    startedAt: Date.now(),
    listeners: new Set<(event: HandoverEvent) => void>(follow ? [follow] : []),
  };
  updating = current;
  const tell = (event: HandoverEvent) => {
    for (const listener of current.listeners) listener(event);
  };
  tell({ kind: "started", release: null, readyTimeoutSeconds });
  const ticker = setInterval(() => {
    const now = operationNow();
    if (now)
      tell({
        kind: "progress",
        seconds: now.seconds,
        phase: now.stage,
        starting: now.starting,
      });
  }, 2_000);
  try {
    const outcome = await run();
    const after = supervisor.status().active?.release ?? "";
    lastOutcome = {
      kind: what,
      by,
      ok: outcome.ok,
      release: after,
      message: outcome.ok
        ? `${what === "install" ? "Updated" : "Rolled back"} to ${outcome.value.to}.`
        : outcome.error.message,
      at: new Date().toISOString(),
    };
    if (by === "schedule") {
      const active = supervisor.status().active;
      const send = active ? workers.get(active.pid) : undefined;
      send?.({
        kind: "update-audit",
        entry: {
          action:
            what === "install"
              ? outcome.ok
                ? "update.installed"
                : "update.install_failed"
              : outcome.ok
                ? "update.rolled_back"
                : "update.rollback_failed",
          release: after,
          message: lastOutcome.message,
        },
      });
    }
    tell(
      outcome.ok
        ? { kind: "done", ok: true, report: outcome.value }
        : { kind: "done", ok: false, error: outcome.error },
    );
    return outcome;
  } finally {
    clearInterval(ticker);
    updating = null;
  }
}

/** Requests of each kind answered lately, for UpdateRequestLimits. */
const answered = new Map<UpdateRequest["kind"], number[]>();
function withinLimit(kind: UpdateRequest["kind"]) {
  const { count, windowMs } = UpdateRequestLimits[kind];
  const now = Date.now();
  const recent = (answered.get(kind) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= count) {
    answered.set(kind, recent);
    return false;
  }
  recent.push(now);
  answered.set(kind, recent);
  return true;
}

/**
 * Answer a server's update request (see update-protocol.ts), already validated: a closed set,
 * none naming a release, a path or a URL. An install takes only what the last check offered, a
 * rollback only the recorded previous release, both through the verified paths.
 */
async function answerUpdate(
  reply: (message: SupervisorMessage) => void,
  id: number,
  request: UpdateRequest,
) {
  const answer = (result: { ok: true } | { ok: false; message: string }) =>
    reply({
      kind: "update-answer",
      id,
      answer: result.ok ? { ok: true, panel: panel() } : result,
    });
  if (!withinLimit(request.kind))
    return answer({
      ok: false,
      message:
        "Too many update requests in a short time, so this one was not carried out. Nothing was changed; wait a minute and try again.",
    });
  switch (request.kind) {
    case "status":
      return answer({ ok: true });
    case "check": {
      const checked = await updater.check();
      return answer(checked.ok ? { ok: true } : checked);
    }
    case "schedule":
      return answer(
        await updater.setSchedule({ mode: request.mode, hour: request.hour }),
      );
    case "install":
    case "rollback": {
      if (updating)
        return answer({
          ok: false,
          message: `An ${updating.kind === "install" ? "update" : "rollback"} is already under way; wait until it has finished, then try again.`,
        });
      await oneAtATime(
        request.kind,
        request.kind === "install" ? installUpdate : rollBack,
        { follow: (event) => reply({ kind: "update-event", id, event }) },
      );
      return;
    }
  }
}

/**
 * The schedule (UpdateSchedule): every ten minutes, a check when one is due, and at the quiet
 * hour, for `install`, the day's one automatic install of what that check offered.
 */
async function scheduled() {
  if (updating || stopping) return;
  const status = updater.status();
  if (status.unavailable || status.source.kind === "off") return;
  let due = UpdateSchedule.due({ now: new Date(), ...updater.scheduling() });
  if (due?.kind === "check") {
    const checked = await updater.check();
    if (!checked.ok) log(`the scheduled check failed: ${checked.message}`);
    due = UpdateSchedule.due({ now: new Date(), ...updater.scheduling() });
  }
  if (due?.kind !== "install" || updating || stopping) return;
  const marked = await updater.markAutomatic(due.day);
  if (!marked.ok)
    return log(`the scheduled install did not start: ${marked.message}`);
  log("installing the offered release at the quiet hour, as the schedule says");
  await oneAtATime("install", installUpdate, { by: "schedule" });
}

/** Install what the last check offered, then hand over to it. */
function installUpdate() {
  return reserved(async (reservation) => {
    const installed = await updater.install();
    if (!installed.ok)
      return {
        ok: false,
        error: { kind: "update-failed", message: installed.message },
      };
    const outcome = await handOver(
      { kind: "installed", name: installed.name },
      reservation,
    );
    if (outcome.ok)
      await updater.prune(
        [supervisor.status().active, ...supervisor.status().draining].flatMap(
          (worker) => (worker ? [worker.release] : []),
        ),
      );
    return outcome;
  });
}

/** Hand back to the release that ran before the current one. */
function rollBack() {
  return reserved(async (reservation) => {
    const target = await updater.rollbackTarget();
    if (!target.ok)
      return {
        ok: false,
        error: { kind: "update-failed", message: target.message },
      };
    if (target.name === null || target.name === BUILT_IN)
      return handOver({ kind: "built-in" }, reservation);
    // Only the installed release that ran before, through the verified path; never one of that
    // name found anywhere else.
    if (!existsSync(path.join(releases, target.name)))
      return {
        ok: false,
        error: {
          kind: "update-failed",
          message: `The release that ran before, ${target.name}, is not installed any more, so there is nothing to roll back to. Nothing was changed; the running release keeps serving.`,
        },
      };
    return handOver({ kind: "installed", name: target.name }, reservation);
  });
}
log(`serving; control socket ${socketPath}`);
setTimeout(() => void scheduled(), 60_000).unref();
setInterval(() => void scheduled(), 10 * 60_000).unref();

process.on("SIGHUP", () => {
  void reserved((reservation) => handOver({ kind: "same" }, reservation)).then(
    (outcome) => {
      if (!outcome.ok) log(`SIGHUP restart refused: ${outcome.error.message}`);
    },
  );
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
// Without its helper the installation is no longer held: another supervisor could start on it.
void installation.exited.then((code) => {
  if (stopping) return;
  log(
    `the helper holding the installation exited (code ${code}), so this supervisor stops rather than run without holding it; the container restarts it`,
  );
  stop("lost installation lock");
});
process.on("SIGINT", () => stop("SIGINT"));
