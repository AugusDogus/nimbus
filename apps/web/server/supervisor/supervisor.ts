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

type Outcome<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Cancels a timer `Clock.after` set. */
export type Cancel = () => void;
/** Time and timers, injected so tests can drive every ordering with a fake clock. */
export type Clock = {
  now: () => number;
  after: (ms: number, run: () => void) => Cancel;
};
export const realClock: Clock = {
  now: Date.now,
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
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
    | "full restart"
    | "never ready";
  /** Responses still being sent, as it last reported. */
  inFlight: number | null;
};

type Grant = { scopes: HeldScope[]; unlock: Unlock };

type Worker = {
  release: Release;
  processId: string;
  process: WorkerProcess;
  startedAt: number;
  previousAssets: string[];
  exited: boolean;
  /** Path scopes it holds, by its request id. */
  grants: Map<number, Grant>;
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
  /** What it held when it died, by grant id, until the changes in each are settled. */
  fence: Map<number, Grant>;
  /** The worker asked to settle it, until it answers or exits. */
  askedOf: Worker | null;
};

type Drainer = {
  worker: Worker;
  drain: Drain;
  /** Kills the worker if it is still running `killGraceMs` past its deadline. */
  cancelKill: Cancel;
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
  /** The replaced worker, now draining, and when it must have finished; null if it had died. */
  draining: { pid: number; deadline: string } | null;
  /** Why every server stopped first instead of a handover, or null for a handover. */
  fullRestart: string | null;
};

type HandoverOutcome = Outcome<HandoverReport, HandoverError>;

/** A release to start, with the earlier builds whose assets it keeps serving. */
type Launch = { release: Release; previousAssets: string[] };

type FullRestartPurpose = {
  kind: "full-restart";
  from: Release;
  reason: string;
  started: number;
  settle: ((outcome: HandoverOutcome) => void) | null;
};

/** Why a candidate is starting, and who waits for it. */
type Purpose =
  | {
      kind: "first-start";
      settle: (outcome: Outcome<void, HandoverError>) => void;
    }
  /**
   * A crashed or failed worker is started again. After a full restart it is the new release that
   * is retried, never the old one: the new one may have applied migrations the old cannot run.
   */
  | { kind: "restart"; afterFullRestart: Release | null }
  | {
      kind: "handover";
      from: Release;
      started: number;
      settle: (outcome: HandoverOutcome) => void;
    }
  | FullRestartPurpose;

type Candidate = {
  worker: Worker;
  purpose: Purpose;
  /** What starts, after a wait, if it never gets ready and nobody else serves. */
  fallback: Launch;
  cancelReady: Cancel;
};

/**
 * What the supervisor is doing. Every live worker is in exactly one place: the active one, the
 * candidate getting ready, or a drainer; a worker that exited is in none.
 */
type State =
  | { kind: "idle" }
  /** A worker is getting ready with nobody serving new connections. */
  | { kind: "starting"; candidate: Candidate; draining: Drainer[] }
  | { kind: "serving"; active: Worker; draining: Drainer[] }
  /** The active worker serves while the candidate that replaces it gets ready. */
  | {
      kind: "handing-over";
      active: Worker;
      candidate: Candidate;
      draining: Drainer[];
    }
  /** Nobody serves; `next` starts when the timer `cancel` belongs to fires. */
  | {
      kind: "restarting";
      next: Launch;
      afterFullRestart: Release | null;
      draining: Drainer[];
      cancel: Cancel;
    }
  /** A release that cannot run beside the others starts once every worker has drained. */
  | {
      kind: "full-restart";
      target: Launch;
      purpose: FullRestartPurpose;
      draining: Drainer[];
    }
  /** Every worker drains; `settle` runs once the last has exited. */
  | { kind: "stopping"; draining: Drainer[]; settle: () => void };

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
  /** Server processes whose unfinished changes are still to be settled, and what stays fenced. */
  recovering: { owner: string; fenced: number }[];
};

export function createSupervisor(deps: {
  run: ServerRun;
  spawn: SpawnWorker;
  settings: SupervisorSettings;
  /**
   * The release a handover names, the one serving when `name` is null at the first start, or why
   * it may not start.
   */
  release: (
    name: string | null,
  ) => { ok: true; release: Release } | { ok: false; reason: string };
  /** The built client of `release`, so the next release can serve its hashed assets. */
  distOf: (release: Release) => string;
  log: (line: string) => void;
  clock?: Clock;
}) {
  const clock = deps.clock ?? realClock;
  const { now } = clock;
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
  const busy = (message: string) => ({
    ok: false as const,
    error: { kind: "busy" as const, message },
  });
  const notReady = (message: string) => ({
    ok: false as const,
    error: { kind: "not-ready" as const, message },
  });

  const drainersOf = (current: State): Drainer[] =>
    current.kind === "idle" ? [] : current.draining;
  const candidateOf = (current: State): Candidate | null =>
    current.kind === "starting" || current.kind === "handing-over"
      ? current.candidate
      : null;
  const activeOf = (current: State): Worker | null =>
    current.kind === "serving" || current.kind === "handing-over"
      ? current.active
      : null;
  /** Every live worker, wherever the state keeps it. */
  const live = (current: State = state): Worker[] =>
    [
      activeOf(current),
      candidateOf(current)?.worker ?? null,
      ...drainersOf(current).map((one) => one.worker),
    ].filter((worker): worker is Worker => worker !== null);

  /** Start a worker, or say why it could not be started. */
  function spawnWorker(
    launch: Launch,
  ): { ok: true; worker: Worker } | { ok: false; reason: string } {
    const processId = `${deps.run.id}-${nextProcess++}`;
    // IPC messages arrive asynchronously, so never before `worker` is set.
    let spawned: Worker | null = null;
    let child: WorkerProcess;
    try {
      child = deps.spawn(
        {
          release: launch.release,
          processId,
          predecessor: live().length > 0,
          previousAssets: launch.previousAssets,
        },
        (message) => {
          if (spawned) onMessage(spawned, message);
        },
      );
    } catch (error) {
      return {
        ok: false,
        reason: `it could not be started (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    const worker: Worker = {
      release: launch.release,
      processId,
      process: child,
      startedAt: now(),
      previousAssets: launch.previousAssets,
      exited: false,
      grants: new Map(),
      fullRestart: null,
    };
    spawned = worker;
    log(`started ${launch.release.name} as pid ${child.pid}`);
    void child.exited.then((code) => onExit(worker, code));
    return { ok: true, worker };
  }

  /** Start a candidate for `purpose`; if it cannot even start, that is its failure. */
  function startCandidate(launch: Launch, purpose: Purpose, fallback: Launch) {
    const spawned = spawnWorker(launch);
    const active = activeOf(state);
    const draining = drainersOf(state);
    if (!spawned.ok) {
      log(`${launch.release.name} ${spawned.reason}`);
      return failed(purpose, fallback, spawned.reason, null, active, draining);
    }
    const { worker } = spawned;
    const candidate: Candidate = {
      worker,
      purpose,
      fallback,
      cancelReady: clock.after(settings.readyTimeoutMs, () => timedOut(worker)),
    };
    state = active
      ? { kind: "handing-over", active, candidate, draining }
      : { kind: "starting", candidate, draining };
  }

  function onMessage(worker: Worker, message: WorkerMessage) {
    if (worker.exited) return;
    switch (message.kind) {
      case "ready":
        return onReady(worker);
      case "in-flight": {
        const found = drainersOf(state).find((one) => one.worker === worker);
        if (found) found.drain.inFlight = message.count;
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
          // It exited while it waited: it never held them.
          if (worker.exited) return unlock();
          worker.grants.set(message.id, { scopes: message.scopes, unlock });
          worker.process.send({ kind: "scopes-granted", id: message.id });
        });
        return;
      case "release-scopes":
        worker.grants.get(message.id)?.unlock();
        worker.grants.delete(message.id);
        return;
      case "fence-release": {
        const recovery = recoveries.find(
          (one) => one.id === message.id && one.askedOf === worker,
        );
        recovery?.fence.get(message.grant)?.unlock();
        recovery?.fence.delete(message.grant);
        return;
      }
      case "recovered": {
        const recovery = recoveries.find(
          (one) => one.id === message.id && one.askedOf === worker,
        );
        if (!recovery) return;
        for (const held of recovery.fence.values()) held.unlock();
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

  /** A live candidate is listening: it takes over, and the one it replaces drains. */
  function onReady(worker: Worker) {
    const candidate = candidateOf(state);
    if (!candidate || candidate.worker !== worker || worker.exited) return;
    candidate.cancelReady();
    let replaced: Drainer | null = null;
    let draining = drainersOf(state);
    if (state.kind === "handing-over") {
      if (draining.length >= settings.maxDraining) {
        const [oldest] = draining;
        if (oldest) drain(oldest, now(), "drain limit");
      }
      replaced = drainer(
        state.active,
        `replaced by ${worker.release.name} at ${iso(now())}`,
        now() + settings.drainMs,
        "drain timeout",
      );
      draining = [...draining, replaced];
    }
    state = { kind: "serving", active: worker, draining };
    worker.process.send({ kind: "active" });
    askToRecover();
    const report = (
      from: Release,
      started: number,
      fullRestart: string | null,
    ): HandoverOutcome => ({
      ok: true,
      value: {
        from: from.name,
        to: worker.release.name,
        readyMs: now() - started,
        draining: replaced && {
          pid: replaced.worker.process.pid,
          deadline: iso(replaced.drain.deadline),
        },
        fullRestart,
      },
    });
    const { purpose } = candidate;
    switch (purpose.kind) {
      case "first-start":
        return purpose.settle({ ok: true, value: undefined });
      case "restart":
        restartDelay = settings.restartMs.initial;
        return log(`${named(worker)} is serving again`);
      case "handover":
        log(`${named(worker)} took over from ${purpose.from.name}`);
        return purpose.settle(report(purpose.from, purpose.started, null));
      case "full-restart":
        restartDelay = settings.restartMs.initial;
        log(`${named(worker)} is serving after a full restart`);
        return purpose.settle?.(
          report(purpose.from, purpose.started, purpose.reason),
        );
    }
  }

  /** The candidate's ready time ran out: it is stopped as a drainer, and counts as failed. */
  function timedOut(worker: Worker) {
    const candidate = candidateOf(state);
    if (!candidate || candidate.worker !== worker) return;
    const reason = `it was not ready within ${Math.round(settings.readyTimeoutMs / 1000)} seconds`;
    log(`${named(worker)}: ${reason}; stopping it`);
    worker.process.kill("SIGTERM");
    const stopping = drainer(worker, "never got ready", now(), "never ready");
    failed(
      candidate.purpose,
      candidate.fallback,
      reason,
      worker,
      activeOf(state),
      [...drainersOf(state), stopping],
    );
  }

  /**
   * A candidate for `purpose` did not take over; it is already out of `draining` unless it is
   * still being stopped there. With an `active` worker the handover is abandoned, or becomes a
   * full restart when the candidate asked for one; with none, `fallback` starts after a wait.
   */
  function failed(
    purpose: Purpose,
    fallback: Launch,
    reason: string,
    worker: Worker | null,
    active: Worker | null,
    draining: Drainer[],
  ) {
    if (active) {
      state = { kind: "serving", active, draining };
      if (worker?.fullRestart && purpose.kind === "handover")
        return beginFullRestart(
          { release: worker.release, previousAssets: worker.previousAssets },
          worker.fullRestart,
          purpose,
        );
      askToRecover();
      if (purpose.kind === "handover") {
        log(`handover from ${purpose.from.name} abandoned: ${reason}`);
        purpose.settle(
          notReady(
            `The new server did not take over because ${reason}. ${purpose.from.name} kept serving throughout; the new worker's log above names the failing step.`,
          ),
        );
      }
      return;
    }
    switch (purpose.kind) {
      case "first-start":
        // Nothing serves and the container stops: what still runs is stopped with it.
        state = { kind: "stopping", draining, settle: () => undefined };
        purpose.settle(
          notReady(
            reason.startsWith("it was not ready")
              ? `Nimbus (${fallback.release.name}) was not ready within ${Math.round(settings.readyTimeoutMs / 1000)} seconds, so it was stopped and the container stops. Its log above names the step it waited on; raise NIMBUS_READY_TIMEOUT_SECONDS if the drive needs longer to index.`
              : `Nimbus (${fallback.release.name}) did not start because ${reason}, so the container stops. Its log above names the failing step.`,
          ),
        );
        return;
      case "restart":
        log(
          purpose.afterFullRestart
            ? `${fallback.release.name} still does not start after the full restart that replaced ${purpose.afterFullRestart.name} (${reason}); trying again in ${restartDelay} ms. Nimbus does not go back to ${purpose.afterFullRestart.name} by itself: ${fallback.release.name} may already have applied database migrations that ${purpose.afterFullRestart.name} cannot run. Requests are refused meanwhile. Fix what its log names and restart the container, or go back by hand: stop the container, restore the pre-migration backup from the config root's backups folder, and start the older image.`
            : `${fallback.release.name} did not start (${reason}); trying again in ${restartDelay} ms`,
        );
        return scheduleRestart(fallback, draining, purpose.afterFullRestart);
      case "handover":
        scheduleRestart(fallback, draining);
        return purpose.settle(
          notReady(
            `The new server did not take over because ${reason}, and ${purpose.from.name} had stopped meanwhile, so ${fallback.release.name} is started again. The new worker's log above names the failing step.`,
          ),
        );
      case "full-restart":
        log(
          `${fallback.release.name} did not start after a full restart (${reason}); trying it again in ${restartDelay} ms, not ${purpose.from.name}, which may not run on the migrated database. If it keeps failing, restore the pre-migration backup from the config root's backups folder and start the older image.`,
        );
        scheduleRestart(fallback, draining, purpose.from);
        purpose.settle?.(
          notReady(
            `${fallback.release.name} did not start after a full restart (${reason}). Nimbus keeps trying it and does not go back to ${purpose.from.name}, whose code may not run on the migrated database; requests are refused meanwhile. Fix what the new worker's log names, or restore the pre-migration backup from the config root's backups folder and start the older image.`,
          ),
        );
        purpose.settle = null;
        return;
    }
  }

  function onExit(worker: Worker, code: number | null) {
    if (worker.exited) return;
    worker.exited = true;
    if (code === NEEDS_FULL_RESTART_EXIT && worker.fullRestart === null)
      worker.fullRestart =
        "it reported that its pending migrations are not safe beside an older server";
    // What it held stays held, fencing changes it may have left half done, until the active
    // worker has settled them; a recovery it was asked to settle goes to the next active one.
    recoveries.push({
      id: nextRecovery++,
      owner: worker.processId,
      fence: new Map(worker.grants),
      askedOf: null,
    });
    worker.grants.clear();
    for (const recovery of recoveries)
      if (recovery.askedOf === worker) recovery.askedOf = null;

    const draining = drainersOf(state);
    const drained = draining.find((one) => one.worker === worker);
    const candidate = candidateOf(state);
    if (drained) {
      drained.cancelKill();
      const rest = draining.filter((one) => one !== drained);
      if (state.kind !== "idle") state = { ...state, draining: rest };
      log(`${named(worker)} exited after draining, code ${code}`);
      if (state.kind === "full-restart" && rest.length === 0)
        startCandidate(state.target, state.purpose, state.target);
      else if (state.kind === "stopping" && rest.length === 0) state.settle();
    } else if (candidate?.worker === worker) {
      candidate.cancelReady();
      failed(
        candidate.purpose,
        candidate.fallback,
        worker.fullRestart
          ? "it asked for a full restart"
          : "it exited before it was ready",
        worker,
        state.kind === "handing-over" ? state.active : null,
        draining,
      );
    } else if (state.kind === "serving" && state.active === worker) {
      log(
        `${named(worker)} exited with code ${code} while serving; starting it again in ${restartDelay} ms. Requests are refused until it is ready.`,
      );
      scheduleRestart(
        { release: worker.release, previousAssets: worker.previousAssets },
        draining,
      );
    } else if (state.kind === "handing-over" && state.active === worker) {
      // The candidate already getting ready takes over; nothing else starts unless it fails.
      log(
        `${named(worker)} exited with code ${code} during a handover; ${named(state.candidate.worker)} takes over once ready. Requests are refused until then.`,
      );
      state = {
        kind: "starting",
        candidate: {
          ...state.candidate,
          fallback: {
            release: worker.release,
            previousAssets: worker.previousAssets,
          },
        },
        draining,
      };
    }
    askToRecover();
  }

  function scheduleRestart(
    next: Launch,
    draining: Drainer[],
    afterFullRestart: Release | null = null,
  ) {
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, settings.restartMs.max);
    const cancel = clock.after(delay, () => {
      if (state.kind !== "restarting" || state.cancel !== cancel) return;
      startCandidate(next, { kind: "restart", afterFullRestart }, next);
    });
    state = { kind: "restarting", next, afterFullRestart, draining, cancel };
  }

  /** Stop every worker within the stop time, then start `target` alone. */
  function beginFullRestart(
    target: Launch,
    reason: string,
    handover: Extract<Purpose, { kind: "handover" }>,
  ) {
    log(
      `${target.release.name} needs a full restart (${reason}): stopping every server within ${settings.stopMs} ms, then starting it alone`,
    );
    const deadline = now() + settings.stopMs;
    const draining = live().map(
      (worker) =>
        drainersOf(state).find((one) => one.worker === worker) ??
        drainer(
          worker,
          `full restart for ${target.release.name}`,
          deadline,
          "full restart",
        ),
    );
    for (const one of draining) drain(one, deadline, "full restart");
    const purpose: FullRestartPurpose = {
      kind: "full-restart",
      from: handover.from,
      reason,
      started: handover.started,
      settle: handover.settle,
    };
    state = { kind: "full-restart", target, purpose, draining };
    if (draining.length === 0) startCandidate(target, purpose, target);
  }

  /** A drainer for `worker`, told to finish by `deadline`, which the supervisor enforces. */
  function drainer(
    worker: Worker,
    reason: string,
    deadline: number,
    deadlineReason: Drain["deadlineReason"],
  ): Drainer {
    const made: Drainer = {
      worker,
      drain: { reason, since: now(), deadline, deadlineReason, inFlight: null },
      cancelKill: () => undefined,
    };
    worker.process.send({ kind: "drain", deadline });
    killAfterDeadline(made);
    return made;
  }

  /** Bring a drainer's deadline forward to `deadline`, never back. */
  function drain(
    target: Drainer,
    deadline: number,
    deadlineReason: Drain["deadlineReason"],
  ) {
    if (target.drain.deadline <= deadline) return;
    target.drain = { ...target.drain, deadline, deadlineReason };
    target.worker.process.send({ kind: "drain", deadline });
    killAfterDeadline(target);
  }

  /** The supervisor, not the worker, makes sure a drainer is gone soon after its deadline. */
  function killAfterDeadline(target: Drainer) {
    target.cancelKill();
    target.cancelKill = clock.after(
      Math.max(0, target.drain.deadline - now()) + settings.killGraceMs,
      () => {
        if (target.worker.exited) return;
        log(
          `${named(target.worker)} was still running ${settings.killGraceMs} ms past its drain deadline; killing it`,
        );
        target.worker.process.kill("SIGKILL");
      },
    );
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
        fence: [...recovery.fence].map(([grant, held]) => ({
          grant,
          scopes: held.scopes,
        })),
      });
    }
  }

  /** Tell whoever waits for a candidate or a full restart that the container is stopping. */
  function abandon(purpose: Purpose) {
    const stopping = busy("The container is stopping, so nothing new starts.");
    switch (purpose.kind) {
      case "first-start":
        return purpose.settle(stopping);
      case "restart":
        return;
      case "handover":
        return purpose.settle(stopping);
      case "full-restart":
        purpose.settle?.(stopping);
        purpose.settle = null;
        return;
    }
  }

  return {
    /** Start the first worker and wait until it serves; an error value if it never does. */
    start(): Promise<Outcome<void, HandoverError>> {
      const found = deps.release(null);
      if (!found.ok)
        return Promise.resolve({
          ok: false,
          error: {
            kind: "unknown-release",
            message: `The supervisor has no release it may run: ${found.reason}.`,
          },
        });
      const { release } = found;
      if (state.kind !== "idle")
        return Promise.resolve(busy("The supervisor already started."));
      return new Promise((settle) => {
        const launch: Launch = { release, previousAssets: [] };
        startCandidate(launch, { kind: "first-start", settle }, launch);
      });
    },

    /**
     * Replace the active worker with one of release `name`, or of the active worker's own
     * release when `name` is null, without closing the port.
     */
    handover(name: string | null): Promise<HandoverOutcome> {
      const current = state;
      if (current.kind !== "serving")
        return Promise.resolve(
          busy(
            current.kind === "stopping"
              ? "The container is stopping, so nothing new starts."
              : current.kind === "handing-over"
                ? `A handover to ${current.candidate.worker.release.name} is under way; try again once it finished.`
                : "Nimbus is not serving yet; try again once it is.",
          ),
        );
      const previous = current.active;
      const found =
        name === null
          ? { ok: true as const, release: previous.release }
          : deps.release(name);
      if (!found.ok)
        return Promise.resolve({
          ok: false,
          error: {
            kind: "unknown-release",
            message: `Release ${name} may not start: ${found.reason}. Nothing was changed; ${previous.release.name} keeps serving.`,
          },
        });
      const { release } = found;
      const previousAssets =
        release.root === previous.release.root
          ? previous.previousAssets
          : [deps.distOf(previous.release), ...previous.previousAssets].slice(
              0,
              2,
            );
      return new Promise((settle) =>
        startCandidate(
          { release, previousAssets },
          { kind: "handover", from: previous.release, started: now(), settle },
          {
            release: previous.release,
            previousAssets: previous.previousAssets,
          },
        ),
      );
    },

    /** Drain every worker within the stop time and wait for them, as a container stop needs. */
    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (state.kind === "stopping") {
          const earlier = state.settle;
          state.settle = () => {
            earlier();
            resolve();
          };
          if (state.draining.length === 0) state.settle();
          return;
        }
        const candidate = candidateOf(state);
        candidate?.cancelReady();
        if (state.kind === "restarting") state.cancel();
        const waiting =
          candidate?.purpose ??
          (state.kind === "full-restart" ? state.purpose : null);
        const deadline = now() + settings.stopMs;
        const draining = live().map(
          (worker) =>
            drainersOf(state).find((one) => one.worker === worker) ??
            drainer(
              worker,
              "the container is stopping",
              deadline,
              "container stop",
            ),
        );
        for (const one of draining) drain(one, deadline, "container stop");
        state = { kind: "stopping", draining, settle: resolve };
        if (waiting) abandon(waiting);
        if (draining.length === 0) resolve();
      });
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
        phase: state.kind,
        active: brief(activeOf(state)),
        starting: brief(candidateOf(state)?.worker ?? null),
        draining: drainersOf(state).map(({ worker, drain }) => ({
          release: worker.release.name,
          pid: worker.process.pid,
          reason: drain.reason,
          since: iso(drain.since),
          deadline: iso(drain.deadline),
          deadlineReason: drain.deadlineReason,
          inFlight: drain.inFlight,
        })),
        recovering: recoveries.map((one) => ({
          owner: one.owner,
          fenced: one.fence.size,
        })),
      };
    },
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;
