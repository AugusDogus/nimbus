import {
  createPathLocks,
  type HeldScope,
  type Release as Unlock,
} from "@nimbus/api/path-locks";
import type { ServerRun } from "@nimbus/api/server-run";
import {
  NEEDS_FULL_RESTART_EXIT,
  type SupervisorMessage,
  type WorkerMessage,
} from "./protocol";

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
  request: {
    release: Release;
    /** Its name within the run, which the changes it records carry. */
    processId: string;
    predecessor: boolean;
    previousAssets: string[];
  },
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
  /**
   * How long past its deadline a draining worker may take to exit before it is killed: its own
   * deadline timer normally ends it, but one that stopped responding must not hold its locks.
   */
  killGraceMs: number;
  /** Waits before starting a crashed worker again: doubled per crash up to the maximum. */
  restartMs: { initial: number; max: number };
};

type Drain = {
  /** Why it drains, for the status. */
  reason: string;
  since: number;
  deadline: number;
  /** Why the deadline is what it is. */
  deadlineReason:
    | "drain timeout"
    | "drain limit"
    | "container stop"
    | "full restart";
  /** Responses still being sent, as it last reported. */
  inFlight: number | null;
};

/** How a new worker's startup ended. */
type Readiness = "ready" | "exited" | "timed out";

type Worker = {
  release: Release;
  processId: string;
  process: WorkerProcess;
  startedAt: number;
  previousAssets: string[];
  /** Settles once it reported ready, or exited first. */
  ready: Promise<"ready" | "exited">;
  exited: boolean;
  /** Path scopes it holds, by its request id. */
  grants: Map<number, { scopes: HeldScope[]; unlock: Unlock }>;
  /** Why it asked for a full restart instead of a handover, if it did. */
  fullRestart: string | null;
};

/**
 * The unfinished changes of a server process that exited, for the active worker to settle,
 * with what that process held, which stays held for it until then.
 */
type Recovery = {
  id: number;
  owner: string;
  fence: { scopes: HeldScope[]; unlock: Unlock }[];
  /** The worker asked to settle it, until it answers or exits. */
  askedOf: Worker | null;
};

type Drainer = {
  worker: Worker;
  drain: Drain;
  /** Kills the worker if it is still running `killGraceMs` past its deadline. */
  killTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * What the supervisor is doing. Every live worker is in exactly one place: the active one, the
 * candidate getting ready, or a drainer; a worker that exited is in none.
 */
type State =
  | { kind: "idle" }
  /**
   * A worker is getting ready with nobody serving new connections: the first start or a restart.
   * If it fails, `fallback` starts after a wait: the release that last served.
   */
  | {
      kind: "starting";
      candidate: Worker;
      fallback: { release: Release; previousAssets: string[] };
      draining: Drainer[];
    }
  | { kind: "serving"; active: Worker; draining: Drainer[] }
  /** The active worker serves while the candidate that replaces it gets ready. */
  | {
      kind: "handing-over";
      active: Worker;
      candidate: Worker;
      draining: Drainer[];
    }
  /** The active worker died; another starts after `timer`. */
  | {
      kind: "restarting";
      release: Release;
      previousAssets: string[];
      draining: Drainer[];
      timer: ReturnType<typeof setTimeout>;
    }
  /**
   * A release that cannot run beside the others is about to start: every worker drains within
   * the stop time first.
   */
  | { kind: "full-restart"; draining: Drainer[] }
  | { kind: "stopping"; draining: Drainer[] };

export type HandoverError =
  | { kind: "busy"; message: string }
  | { kind: "unknown-release"; message: string }
  | { kind: "not-ready"; message: string };

export type HandoverReport = {
  from: string;
  to: string;
  /** From starting the new worker to its ready message, which it sends once listening. */
  readyMs: number;
  /** The replaced worker, now draining, and when it must have finished; null if it had died. */
  draining: { pid: number; deadline: string } | null;
  /** Why every server stopped first instead of a handover, or null for a handover. */
  fullRestart: string | null;
};

export type SupervisorStatus = {
  run: ServerRun;
  phase: State["kind"];
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

/** How waiting for a candidate ended, as the state machine left it. */
type Promotion =
  | { kind: "promoted"; replaced: Drainer | null }
  | { kind: "failed"; reason: string }
  | { kind: "stopping" };

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
  let state: State = { kind: "idle" };
  let recoveries: Recovery[] = [];
  let nextRecovery = 1;
  let nextProcess = 1;
  let restartDelay = settings.restartMs.initial;
  const iso = (time: number) => new Date(time).toISOString();
  const named = (worker: Worker) =>
    `${worker.release.name} (pid ${worker.process.pid})`;

  const drainersOf = (current: State): Drainer[] =>
    current.kind === "idle" ? [] : current.draining;
  /** Every live worker, wherever the state keeps it. */
  function live(current: State = state): Worker[] {
    const drainers = drainersOf(current).map((drainer) => drainer.worker);
    switch (current.kind) {
      case "idle":
      case "restarting":
      case "full-restart":
      case "stopping":
        return drainers;
      case "starting":
        return [current.candidate, ...drainers];
      case "serving":
        return [current.active, ...drainers];
      case "handing-over":
        return [current.active, current.candidate, ...drainers];
    }
  }
  const withDraining = (draining: Drainer[]): State => {
    switch (state.kind) {
      case "idle":
        return state;
      default:
        return { ...state, draining };
    }
  };

  function spawn(release: Release, previousAssets: string[]): Worker {
    const ready = Promise.withResolvers<"ready" | "exited">();
    // IPC messages arrive asynchronously, so never before `worker` is set.
    let spawned: Worker | null = null;
    const processId = `${deps.run.id}-${nextProcess++}`;
    const child = deps.spawn(
      { release, processId, predecessor: live().length > 0, previousAssets },
      (message) => {
        if (!spawned) return;
        if (message.kind === "ready") ready.resolve("ready");
        else onMessage(spawned, message);
      },
    );
    const worker: Worker = {
      release,
      processId,
      process: child,
      startedAt: now(),
      previousAssets,
      ready: ready.promise,
      exited: false,
      grants: new Map(),
      fullRestart: null,
    };
    spawned = worker;
    log(`started ${release.name} as pid ${child.pid}`);
    void child.exited.then((code) => {
      ready.resolve("exited");
      onExit(worker, code);
    });
    return worker;
  }

  function onMessage(
    worker: Worker,
    message: Exclude<WorkerMessage, { kind: "ready" }>,
  ) {
    switch (message.kind) {
      case "in-flight": {
        const drainer = drainersOf(state).find((d) => d.worker === worker);
        if (drainer) drainer.drain.inFlight = message.count;
        return;
      }
      case "needs-full-restart":
        worker.fullRestart = message.reason;
        return;
      case "drained":
        log(
          `${named(worker)} drained${message.forced ? " at its deadline, cutting the responses still being sent" : ", every response finished"}`,
        );
        return;
      case "acquire-scopes":
        void scopes.acquire(message.scopes).then((unlock) => {
          // It exited while it waited: nobody holds them.
          if (worker.exited) return unlock();
          worker.grants.set(message.id, { scopes: message.scopes, unlock });
          worker.process.send({ kind: "scopes-granted", id: message.id });
        });
        return;
      case "release-scopes":
        worker.grants.get(message.id)?.unlock();
        worker.grants.delete(message.id);
        return;
      case "fence-done": {
        const recovery = recoveries.find(
          (one) => one.id === message.id && one.askedOf === worker,
        );
        if (!recovery) return;
        for (const held of recovery.fence) held.unlock();
        recoveries = recoveries.filter((one) => one !== recovery);
        log(`${named(worker)} settled what ${recovery.owner} left unfinished`);
        return;
      }
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
    worker.exited = true;
    if (code === NEEDS_FULL_RESTART_EXIT && worker.fullRestart === null)
      worker.fullRestart =
        "it reported that its pending migrations are not safe beside an older server";
    // What it held stays held, fencing changes it may have left half done, until the active
    // worker has settled them; a recovery it was asked to settle goes to the next active one.
    recoveries.push({
      id: nextRecovery++,
      owner: worker.processId,
      fence: [...worker.grants.values()],
      askedOf: null,
    });
    worker.grants.clear();
    for (const recovery of recoveries)
      if (recovery.askedOf === worker) recovery.askedOf = null;
    const draining = drainersOf(state);
    const drained = draining.find((drainer) => drainer.worker === worker);
    if (drained?.killTimer) clearTimeout(drained.killTimer);
    if (drained) {
      state = withDraining(draining.filter((d) => d.worker !== worker));
      log(`${named(worker)} exited after draining, code ${code}`);
    } else if (state.kind === "serving" && state.active === worker) {
      log(
        `${named(worker)} exited with code ${code} while serving; starting it again in ${restartDelay} ms. Requests are refused until it is ready.`,
      );
      scheduleRestart(worker.release, worker.previousAssets, state.draining);
    } else if (state.kind === "handing-over" && state.active === worker) {
      // The candidate already getting ready takes over; nothing else starts unless it fails.
      log(
        `${named(worker)} exited with code ${code} during a handover; ${named(state.candidate)} takes over once ready. Requests are refused until then.`,
      );
      state = {
        kind: "starting",
        candidate: state.candidate,
        fallback: {
          release: worker.release,
          previousAssets: worker.previousAssets,
        },
        draining: state.draining,
      };
    }
    // A candidate that exits is handled where its readiness is awaited.
    askToRecover();
  }

  function scheduleRestart(
    release: Release,
    previousAssets: string[],
    draining: Drainer[],
  ) {
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, settings.restartMs.max);
    const timer = setTimeout(() => {
      if (state.kind !== "restarting" || state.timer !== timer) return;
      const candidate = spawn(release, previousAssets);
      state = {
        kind: "starting",
        candidate,
        fallback: { release, previousAssets },
        draining: state.draining,
      };
      void promote(candidate).then((outcome) => {
        if (outcome.kind === "promoted") {
          restartDelay = settings.restartMs.initial;
          log(`${named(candidate)} is serving again`);
        }
      });
    }, delay);
    state = { kind: "restarting", release, previousAssets, draining, timer };
  }

  /**
   * Wait for `candidate` to get ready, then make it the active worker: the one it replaces, if
   * that one still lives, drains. If it never gets ready, the active worker keeps serving, or,
   * when there is none, another starts after a wait.
   */
  async function promote(candidate: Worker): Promise<Promotion> {
    const readiness = await readinessOf(candidate);
    const current = state;
    const mine =
      (current.kind === "handing-over" || current.kind === "starting") &&
      current.candidate === candidate;
    if (readiness === "ready" && mine) {
      let replaced: Drainer | null = null;
      let draining = current.draining;
      if (current.kind === "handing-over") {
        if (draining.length >= settings.maxDraining) {
          const [oldest] = draining;
          if (oldest) drain(oldest, now(), "drain limit");
        }
        replaced = {
          worker: current.active,
          killTimer: null,
          drain: {
            reason: `replaced by ${candidate.release.name} at ${iso(now())}`,
            since: now(),
            deadline: now() + settings.drainMs,
            deadlineReason: "drain timeout",
            inFlight: null,
          },
        };
        current.active.process.send({
          kind: "drain",
          deadline: replaced.drain.deadline,
        });
        killAfterDeadline(replaced);
        draining = [...draining, replaced];
      }
      state = { kind: "serving", active: candidate, draining };
      candidate.process.send({ kind: "active" });
      askToRecover();
      return { kind: "promoted", replaced };
    }
    const reason =
      readiness === "timed out"
        ? `it was not ready within ${Math.round(settings.readyTimeoutMs / 1000)} seconds`
        : "it exited before it was ready";
    const after = state;
    if (after.kind === "handing-over" && after.candidate === candidate) {
      state = {
        kind: "serving",
        active: after.active,
        draining: after.draining,
      };
      askToRecover();
      return { kind: "failed", reason };
    }
    if (after.kind === "starting" && after.candidate === candidate) {
      log(
        `${named(candidate)} did not start (${reason}); trying again in ${restartDelay} ms`,
      );
      scheduleRestart(
        after.fallback.release,
        after.fallback.previousAssets,
        after.draining,
      );
      return { kind: "failed", reason };
    }
    return after.kind === "stopping"
      ? { kind: "stopping" }
      : { kind: "failed", reason };
  }

  /**
   * How `candidate`'s startup ended: every worker gets `readyTimeoutMs`, and one that is not
   * ready by then, such as one whose search index never finished, is stopped.
   */
  async function readinessOf(candidate: Worker): Promise<Readiness> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readiness = await Promise.race([
      candidate.ready,
      new Promise<"timed out">((resolve) => {
        timer = setTimeout(() => resolve("timed out"), settings.readyTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (readiness !== "ready" && !candidate.exited) {
      candidate.process.kill("SIGTERM");
      await reap(candidate, 5_000);
    }
    return readiness;
  }

  /** Ask the active worker to settle what exited workers left, each recovery once. */
  function askToRecover() {
    if (state.kind !== "serving") return;
    const { active } = state;
    for (const recovery of recoveries) {
      if (recovery.askedOf) continue;
      recovery.askedOf = active;
      active.process.send({
        kind: "recover",
        id: recovery.id,
        owner: recovery.owner,
        fence: recovery.fence.flatMap((held) => held.scopes),
      });
    }
  }

  /** Bring a drainer's deadline forward to `deadline`, never back. */
  function drain(
    drainer: Drainer,
    deadline: number,
    deadlineReason: Drain["deadlineReason"],
  ) {
    if (drainer.drain.deadline <= deadline) return;
    drainer.drain = { ...drainer.drain, deadline, deadlineReason };
    drainer.worker.process.send({ kind: "drain", deadline });
    killAfterDeadline(drainer);
  }

  /** The supervisor, not the worker, makes sure a drainer is gone soon after its deadline. */
  function killAfterDeadline(drainer: Drainer) {
    if (drainer.killTimer) clearTimeout(drainer.killTimer);
    drainer.killTimer = setTimeout(
      () => {
        if (drainer.worker.exited) return;
        log(
          `${named(drainer.worker)} was still running ${settings.killGraceMs} ms past its drain deadline; killing it`,
        );
        drainer.worker.process.kill("SIGKILL");
      },
      Math.max(0, drainer.drain.deadline - now()) + settings.killGraceMs,
    );
  }

  /** Wait for `worker` to exit, killing it if it outlasts `graceMs`. */
  async function reap(worker: Worker, graceMs: number) {
    if (worker.exited) return;
    const timer = setTimeout(() => worker.process.kill("SIGKILL"), graceMs);
    await worker.process.exited;
    clearTimeout(timer);
  }

  /**
   * Stop every worker within the stop time, then start `release` alone, as a release whose
   * migrations cannot run beside older servers needs. Responses still running are cut.
   */
  async function fullRestart(
    release: Release,
    reason: string,
    started: number,
  ): Promise<Outcome<HandoverReport, HandoverError>> {
    if (state.kind !== "serving")
      return busy("The supervisor's state changed meanwhile; try again.");
    const previous = state.active;
    log(
      `${release.name} needs a full restart (${reason}): stopping every server within ${settings.stopMs} ms, then starting it alone`,
    );
    const deadline = now() + settings.stopMs;
    const workers = live();
    const drainers = workers.map(
      (worker) =>
        drainersOf(state).find((drainer) => drainer.worker === worker) ?? {
          worker,
          killTimer: null,
          drain: {
            reason: `full restart for ${release.name}`,
            since: now(),
            deadline: Number.POSITIVE_INFINITY,
            deadlineReason: "full restart" as const,
            inFlight: null,
          },
        },
    );
    state = { kind: "full-restart", draining: drainers };
    for (const drainer of drainers) drain(drainer, deadline, "full restart");
    await Promise.all(
      workers.map((worker) =>
        reap(worker, settings.stopMs + settings.killGraceMs),
      ),
    );
    if (state.kind !== "full-restart")
      return busy("The container is stopping, so nothing new starts.");
    const candidate = spawn(release, previous.previousAssets);
    state = {
      kind: "starting",
      candidate,
      fallback: {
        release: previous.release,
        previousAssets: previous.previousAssets,
      },
      draining: [],
    };
    const outcome = await promote(candidate);
    if (outcome.kind !== "promoted")
      return {
        ok: false,
        error: {
          kind: "not-ready",
          message: `${release.name} did not start after a full restart (${outcome.kind === "failed" ? outcome.reason : "the container is stopping"}). ${previous.release.name} is started again; the new worker's log above names the failing step.`,
        },
      };
    return {
      ok: true,
      value: {
        from: previous.release.name,
        to: release.name,
        readyMs: now() - started,
        draining: null,
        fullRestart: reason,
      },
    };
  }

  const busy = (message: string) => ({
    ok: false as const,
    error: { kind: "busy" as const, message },
  });

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
      if (state.kind !== "idle") return busy("The supervisor already started.");
      const candidate = spawn(release, []);
      state = {
        kind: "starting",
        candidate,
        fallback: { release, previousAssets: [] },
        draining: [],
      };
      const ready = await readinessOf(candidate);
      const current = state;
      if (
        ready === "ready" &&
        current.kind === "starting" &&
        current.candidate === candidate
      ) {
        state = { kind: "serving", active: candidate, draining: [] };
        candidate.process.send({ kind: "active" });
        askToRecover();
        return { ok: true, value: undefined };
      }
      state = { kind: "idle" };
      return {
        ok: false,
        error: {
          kind: "not-ready",
          message:
            ready === "timed out"
              ? `Nimbus (${release.name}) was not ready within ${Math.round(settings.readyTimeoutMs / 1000)} seconds, so it was stopped and the container stops. Its log above names the step it waited on; raise NIMBUS_READY_TIMEOUT_SECONDS if the drive needs longer to index.`
              : `Nimbus (${release.name}) exited before it was ready, so the container stops. Its log above names the failing step.`,
        },
      };
    },

    /**
     * Replace the active worker with one of release `name`, or of the active worker's own
     * release when `name` is null, without closing the port.
     */
    async handover(
      name: string | null,
    ): Promise<Outcome<HandoverReport, HandoverError>> {
      const current = state;
      if (current.kind !== "serving")
        return busy(
          current.kind === "stopping"
            ? "The container is stopping, so nothing new starts."
            : current.kind === "handing-over"
              ? `A handover to ${current.candidate.release.name} is under way; try again once it finished.`
              : "Nimbus is not serving yet; try again once it is.",
        );
      const previous = current.active;
      const release = name === null ? previous.release : deps.release(name);
      if (!release)
        return {
          ok: false,
          error: {
            kind: "unknown-release",
            message: `There is no release named ${name}. Nothing was changed; ${previous.release.name} keeps serving.`,
          },
        };
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
      state = {
        kind: "handing-over",
        active: previous,
        candidate,
        draining: current.draining,
      };
      const outcome = await promote(candidate);
      switch (outcome.kind) {
        case "promoted":
          log(
            `${named(candidate)} took over from ${named(previous)} in ${now() - started} ms`,
          );
          return {
            ok: true,
            value: {
              from: previous.release.name,
              to: release.name,
              readyMs: now() - started,
              draining: outcome.replaced && {
                pid: outcome.replaced.worker.process.pid,
                deadline: iso(outcome.replaced.drain.deadline),
              },
              fullRestart: null,
            },
          };
        case "failed":
          if (candidate.fullRestart !== null)
            return fullRestart(release, candidate.fullRestart, started);
          log(`handover to ${release.name} abandoned: ${outcome.reason}`);
          return {
            ok: false,
            error: {
              kind: "not-ready",
              message: previous.exited
                ? `${release.name} did not take over because ${outcome.reason}, and ${previous.release.name} had stopped meanwhile, so it is being started again. The new worker's log above names the failing step.`
                : `${release.name} did not take over because ${outcome.reason}. ${previous.release.name} kept serving throughout; the new worker's log above names the failing step.`,
            },
          };
        case "stopping":
          return busy("The container is stopping, so nothing new starts.");
      }
    },

    /** Drain every worker within the stop time and wait for them, as a container stop needs. */
    async stop() {
      if (state.kind === "stopping") return;
      if (state.kind === "restarting") clearTimeout(state.timer);
      const deadline = now() + settings.stopMs;
      const workers = live();
      const draining = drainersOf(state);
      const drainers = workers.map(
        (worker) =>
          draining.find((drainer) => drainer.worker === worker) ?? {
            worker,
            killTimer: null,
            drain: {
              reason: "the container is stopping",
              since: now(),
              deadline: Number.POSITIVE_INFINITY,
              deadlineReason: "container stop" as const,
              inFlight: null,
            },
          },
      );
      state = { kind: "stopping", draining: drainers };
      for (const drainer of drainers)
        drain(drainer, deadline, "container stop");
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
      const current = state;
      return {
        run: deps.run,
        phase: current.kind,
        active:
          current.kind === "serving" || current.kind === "handing-over"
            ? brief(current.active)
            : null,
        starting:
          current.kind === "starting" || current.kind === "handing-over"
            ? brief(current.candidate)
            : null,
        draining: drainersOf(current).map(({ worker, drain }) => ({
          release: worker.release.name,
          pid: worker.process.pid,
          reason: drain.reason,
          since: iso(drain.since),
          deadline: iso(drain.deadline),
          deadlineReason: drain.deadlineReason,
          inFlight: drain.inFlight,
        })),
      };
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;
