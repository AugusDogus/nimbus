import {
  createPathLocks,
  type Release as Unlock,
} from "@nimbus/api/path-locks";
import type { ServerRun } from "@nimbus/api/server-run";
import type { SupervisorMessage, WorkerMessage } from "./protocol";

/**
 * Owns the container's lifetime and replaces the Nimbus server it runs (a worker) without
 * closing the port. A handover starts the next worker beside the active one; the next one
 * listens on the same port with `reusePort` once it is ready, and then the old one drains: it
 * leaves the port at once and keeps sending the responses it had started, such as a film, until
 * they end or its drain deadline passes. If the next worker never gets ready, it is stopped and
 * the active one keeps serving untouched.
 *
 * Several workers may drain at once after back-to-back updates. At most `maxDraining` do: when
 * one more would start draining, the oldest is told to finish now.
 *
 * While more than one worker runs, the supervisor grants the path scopes file changes hold (see
 * `mutateFiles`) for all of them, so their changes never overlap, and it passes transfer
 * signals from each worker to the others.
 */

/** A directory holding a build of the repository: `apps/web` with its server and client. */
export type Release = { name: string; root: string };

export type WorkerProcess = {
  pid: number;
  send: (message: SupervisorMessage) => void;
  kill: (signal: "SIGTERM" | "SIGKILL") => void;
  /** Settles with the exit code once the process has exited. */
  exited: Promise<number | null>;
};

export type SpawnWorker = (
  request: { release: Release; predecessor: boolean; previousAssets: string[] },
  onMessage: (message: WorkerMessage) => void,
) => WorkerProcess;

export type SupervisorSettings = {
  /** How long a new worker may take to get ready before it is stopped. */
  readyTimeoutMs: number;
  /** How long a draining worker may keep sending the responses it had started. */
  drainMs: number;
  /** Draining workers kept at once; one more makes the oldest finish now. */
  maxDraining: number;
  /** How long workers may drain when the container stops. */
  stopMs: number;
  /** Waits before starting a crashed worker again: doubled per crash up to the maximum. */
  restartMs: { initial: number; max: number };
};

type ReadyMessage = Extract<WorkerMessage, { kind: "ready" }>;

type Drain = {
  /** Why it drains, for the status. */
  reason: string;
  since: number;
  deadline: number;
  /** Why the deadline is what it is. */
  deadlineReason: "drain timeout" | "drain limit" | "container stop";
  /** Responses still being sent, as it last reported. */
  inFlight: number | null;
};

type Worker = {
  release: Release;
  process: WorkerProcess;
  startedAt: number;
  previousAssets: string[];
  /** Settles with its ready message, or null when it exited first. */
  ready: Promise<ReadyMessage | null>;
  exitCode: number | null | undefined;
  /** Path scopes it holds, by its request id. */
  grants: Map<number, Unlock>;
  drain: Drain | null;
  toldAlone: boolean;
};

export type HandoverError =
  | { kind: "busy"; message: string }
  | { kind: "unknown-release"; message: string }
  | { kind: "not-ready"; message: string };

export type HandoverReport = {
  from: string;
  to: string;
  /** From starting the new worker to its ready message, which it sends once listening. */
  readyMs: number;
  /** The replaced worker, now draining, and when it must have finished. */
  draining: { pid: number; deadline: string };
};

export type SupervisorStatus = {
  run: ServerRun;
  phase: "starting" | "serving" | "stopping";
  active: { release: string; pid: number; since: string } | null;
  starting: { release: string; pid: number; since: string } | null;
  draining: {
    release: string;
    pid: number;
    reason: string;
    since: string;
    deadline: string;
    deadlineReason: Drain["deadlineReason"];
    inFlight: number | null;
  }[];
};

type Outcome<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function createSupervisor(deps: {
  run: ServerRun;
  spawn: SpawnWorker;
  settings: SupervisorSettings;
  /** The release a handover names, or null when there is none by that name. */
  release: (name: string | null) => Release | null;
  /** The built client of `release`, so the next release can serve its hashed assets. */
  distOf: (release: Release) => string;
  log: (line: string) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const { settings, log } = deps;
  const scopes = createPathLocks();
  let phase: SupervisorStatus["phase"] = "starting";
  let active: Worker | null = null;
  let next: Worker | null = null;
  let draining: Worker[] = [];
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartDelay = settings.restartMs.initial;
  const iso = (time: number) => new Date(time).toISOString();
  const live = () =>
    [active, next, ...draining].filter(
      (worker): worker is Worker => worker !== null,
    );

  function spawn(release: Release, previousAssets: string[]): Worker {
    const ready = Promise.withResolvers<ReadyMessage | null>();
    // IPC messages arrive asynchronously, so never before `worker` is set.
    let spawned: Worker | null = null;
    const child = deps.spawn(
      { release, predecessor: live().length > 0, previousAssets },
      (message) => {
        if (spawned) onMessage(spawned, message, ready.resolve);
      },
    );
    const worker: Worker = {
      release,
      process: child,
      startedAt: now(),
      previousAssets,
      ready: ready.promise,
      exitCode: undefined,
      grants: new Map(),
      drain: null,
      toldAlone: false,
    };
    spawned = worker;
    log(`started ${release.name} as pid ${worker.process.pid}`);
    void worker.process.exited.then((code) => {
      ready.resolve(null);
      onExit(worker, code);
    });
    return worker;
  }

  function onMessage(
    worker: Worker,
    message: WorkerMessage,
    ready: (message: ReadyMessage) => void,
  ) {
    switch (message.kind) {
      case "ready":
        ready(message);
        return;
      case "in-flight":
        if (worker.drain) worker.drain.inFlight = message.count;
        return;
      case "drained":
        log(
          `${worker.release.name} (pid ${worker.process.pid}) drained${message.forced ? " at its deadline, cutting the responses still being sent" : ", every response finished"}`,
        );
        return;
      case "acquire-scopes":
        void scopes.acquire(message.scopes).then((unlock) => {
          // It exited while it waited: nobody holds them.
          if (worker.exitCode !== undefined) return unlock();
          worker.grants.set(message.id, unlock);
          worker.process.send({ kind: "scopes-granted", id: message.id });
        });
        return;
      case "release-scopes":
        worker.grants.get(message.id)?.();
        worker.grants.delete(message.id);
        return;
      case "transfer-signal":
        for (const other of live())
          if (other !== worker)
            other.process.send({
              kind: "transfer-signal",
              signal: message.signal,
            });
        return;
    }
  }

  function onExit(worker: Worker, code: number | null) {
    worker.exitCode = code;
    // A worker that exits holds nothing any more, whatever it was doing.
    for (const unlock of worker.grants.values()) unlock();
    worker.grants.clear();
    if (draining.includes(worker)) {
      draining = draining.filter((other) => other !== worker);
      log(
        `${worker.release.name} (pid ${worker.process.pid}) exited after draining, code ${code}`,
      );
    } else if (worker === active && phase === "serving") {
      active = null;
      log(
        `${worker.release.name} (pid ${worker.process.pid}) exited with code ${code} while serving; starting it again in ${restartDelay} ms. Requests are refused until it is ready.`,
      );
      scheduleRestart(worker.release, worker.previousAssets);
    }
    tellAlone();
  }

  function scheduleRestart(release: Release, previousAssets: string[]) {
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, settings.restartMs.max);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (phase !== "serving" || active) return;
      const worker = spawn(release, previousAssets);
      active = worker;
      void worker.ready.then((ready) => {
        if (!ready || active !== worker) return;
        restartDelay = settings.restartMs.initial;
        log(`${release.name} (pid ${worker.process.pid}) is serving again`);
        worker.process.send({ kind: "active" });
        tellAlone();
      });
    }, delay);
  }

  /** Tell the active worker once when it runs alone: crash recovery may start. */
  function tellAlone() {
    if (!active || active.toldAlone || next || draining.length) return;
    active.toldAlone = true;
    active.process.send({ kind: "alone" });
  }

  /** Make `worker` drain until `deadline`, or sooner if it already drains to an earlier one. */
  function drain(
    worker: Worker,
    reason: string,
    deadline: number,
    deadlineReason: Drain["deadlineReason"],
  ) {
    if (worker.drain && worker.drain.deadline <= deadline) return;
    worker.drain = worker.drain
      ? { ...worker.drain, deadline, deadlineReason }
      : { reason, since: now(), deadline, deadlineReason, inFlight: null };
    worker.process.send({ kind: "drain", deadline });
  }

  /** Stop `worker` and wait for it, killing it if it outlasts `graceMs`. */
  async function reap(worker: Worker, graceMs: number) {
    if (worker.exitCode !== undefined) return worker.exitCode;
    const timer = setTimeout(() => worker.process.kill("SIGKILL"), graceMs);
    const code = await worker.process.exited;
    clearTimeout(timer);
    return code;
  }

  return {
    /** Start the first worker and wait until it serves; an error value if it never does. */
    async start(): Promise<Outcome<void, HandoverError>> {
      const release = deps.release(null);
      if (!release)
        return {
          ok: false,
          error: {
            kind: "unknown-release",
            message: "The supervisor found no release to run.",
          },
        };
      const worker = spawn(release, []);
      active = worker;
      const ready = await worker.ready;
      if (!ready) {
        active = null;
        return {
          ok: false,
          error: {
            kind: "not-ready",
            message: `Nimbus (${release.name}) exited before it was ready, so the container stops. Its log above names the failing step.`,
          },
        };
      }
      phase = "serving";
      worker.process.send({ kind: "active" });
      tellAlone();
      return { ok: true, value: undefined };
    },

    /**
     * Replace the active worker with one of release `name`, or of the active worker's own
     * release when `name` is null, without closing the port.
     */
    async handover(
      name: string | null,
    ): Promise<Outcome<HandoverReport, HandoverError>> {
      if (phase !== "serving" || !active || next)
        return {
          ok: false,
          error: {
            kind: "busy",
            message:
              phase === "stopping"
                ? "The container is stopping, so nothing new starts."
                : next
                  ? `A handover to ${next.release.name} is under way; try again once it finished.`
                  : "Nimbus is not serving yet; try again once it is.",
          },
        };
      const release = name === null ? active.release : deps.release(name);
      if (!release)
        return {
          ok: false,
          error: {
            kind: "unknown-release",
            message: `There is no release named ${name}. Nothing was changed; ${active.release.name} keeps serving.`,
          },
        };
      const previous = active;
      const started = now();
      const candidate = spawn(
        release,
        release.root === previous.release.root
          ? previous.previousAssets
          : [deps.distOf(previous.release), ...previous.previousAssets].slice(
              0,
              2,
            ),
      );
      next = candidate;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ready = await Promise.race([
        candidate.ready,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), settings.readyTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (ready === null || ready === "timeout") {
        candidate.process.kill("SIGTERM");
        await reap(candidate, 5_000);
        next = null;
        const reason =
          ready === null
            ? "it exited before it was ready"
            : `it was not ready within ${Math.round(settings.readyTimeoutMs / 1000)} seconds`;
        log(
          `handover to ${release.name} abandoned: ${reason}; ${previous.release.name} keeps serving`,
        );
        tellAlone();
        return {
          ok: false,
          error: {
            kind: "not-ready",
            message: `${release.name} did not take over because ${reason}. ${previous.release.name} kept serving throughout; the new worker's log above names the failing step.`,
          },
        };
      }
      // The next worker is listening. The old one leaves the port, keeping what it is sending.
      next = null;
      active = candidate;
      if (draining.length >= settings.maxDraining) {
        const [oldest] = draining;
        if (oldest)
          drain(oldest, oldest.drain?.reason ?? "", now(), "drain limit");
      }
      const deadline = now() + settings.drainMs;
      drain(
        previous,
        `replaced by ${release.name} at ${iso(now())}`,
        deadline,
        "drain timeout",
      );
      draining = [...draining, previous];
      candidate.process.send({ kind: "active" });
      log(
        `${release.name} (pid ${candidate.process.pid}) took over from ${previous.release.name} (pid ${previous.process.pid}) in ${now() - started} ms`,
      );
      return {
        ok: true,
        value: {
          from: previous.release.name,
          to: release.name,
          readyMs: now() - started,
          draining: { pid: previous.process.pid, deadline: iso(deadline) },
        },
      };
    },

    /** Drain every worker within the stop time and wait for them, as a container stop needs. */
    async stop() {
      if (phase === "stopping") return;
      phase = "stopping";
      if (restartTimer) clearTimeout(restartTimer);
      const deadline = now() + settings.stopMs;
      const workers = live();
      for (const worker of workers)
        drain(worker, "the container is stopping", deadline, "container stop");
      await Promise.all(
        workers.map((worker) => reap(worker, settings.stopMs + 5_000)),
      );
    },

    status(): SupervisorStatus {
      const brief = (worker: Worker | null) =>
        worker && {
          release: worker.release.name,
          pid: worker.process.pid,
          since: iso(worker.startedAt),
        };
      return {
        run: deps.run,
        phase,
        active: brief(active),
        starting: brief(next),
        draining: draining.flatMap((worker) =>
          worker.drain
            ? [
                {
                  release: worker.release.name,
                  pid: worker.process.pid,
                  reason: worker.drain.reason,
                  since: iso(worker.drain.since),
                  deadline: iso(worker.drain.deadline),
                  deadlineReason: worker.drain.deadlineReason,
                  inFlight: worker.drain.inFlight,
                },
              ]
            : [],
        ),
      };
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;
