import { expect, test } from "bun:test";
import type { SupervisorMessage, WorkerMessage } from "./protocol";
import {
  createSupervisor,
  type Cancel,
  type Clock,
  type Release,
  type SpawnWorker,
  type SupervisorSettings,
} from "./supervisor";

/**
 * A model test of the supervisor: seeded random orderings of every event it can receive, against
 * fake workers and a fake clock, with its invariants checked after every step. A failure names
 * its seed and the events that led to it; rerun one with SUPERVISOR_MODEL_SEED=<seed>.
 *
 * CI runs a fixed set of seeds; SUPERVISOR_MODEL_SEEDS raises how many.
 */
const SEEDS = Number(process.env.SUPERVISOR_MODEL_SEEDS ?? 300);
const ONLY = process.env.SUPERVISOR_MODEL_SEED;
const STEPS = 160;
/** What the sequences reached, printed with SUPERVISOR_MODEL_COVERAGE=1. */
const coverage = new Map<string, number>();
const reached = (what: string) =>
  coverage.set(what, (coverage.get(what) ?? 0) + 1);

const settings: SupervisorSettings = {
  readyTimeoutMs: 5_000,
  drainMs: 60_000,
  maxDraining: 2,
  stopMs: 3_000,
  killGraceMs: 1_000,
  restartMs: { initial: 100, max: 800 },
};

/** A small fast generator, so every sequence can be replayed from its seed. */
function generator(seed: number) {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    below: (count: number) => Math.floor(next() * count),
    chance: (probability: number) => next() < probability,
  };
}

class FakeClock implements Clock {
  time = 1_000_000;
  private timers: { at: number; order: number; run: () => void }[] = [];
  private order = 0;
  now = () => this.time;
  after = (ms: number, run: () => void): Cancel => {
    const timer = { at: this.time + Math.max(0, ms), order: this.order++, run };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((other) => other !== timer);
    };
  };
  get pending() {
    return this.timers.length;
  }
  /** Move to the earliest timer and run it. */
  fireNext() {
    const [earliest] = [...this.timers].sort(
      (a, b) => a.at - b.at || a.order - b.order,
    );
    if (!earliest) return false;
    this.timers = this.timers.filter((other) => other !== earliest);
    this.time = Math.max(this.time, earliest.at);
    earliest.run();
    return true;
  }
}

type Fake = {
  pid: number;
  processId: string;
  release: string;
  alive: boolean;
  readySent: boolean;
  terminating: boolean;
  /** Scope grants it holds, by request id. */
  holding: Set<number>;
  waiting: Set<number>;
  nextRequest: number;
  /** Recovery requests it was sent and has not answered, with the grants still fenced. */
  asked: { id: number; owner: string; grants: number[] }[];
  say: (message: WorkerMessage) => void;
  exit: (code: number | null) => void;
};

const releases: Record<string, Release> = {
  a: { name: "a", root: "/releases/a" },
  b: { name: "b", root: "/releases/b" },
};

/** Let promise callbacks the last event queued run, as the event loop would. */
const flush = async () => {
  for (let round = 0; round < 4; round++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

async function runSequence(seed: number) {
  const random = generator(seed);
  const clock = new FakeClock();
  const fakes: Fake[] = [];
  const history: string[] = [];
  let spawnThrows = false;
  let releaseBGone = false;
  /** Server processes that died holding scopes and whose changes nobody has settled yet. */
  const unsettled = new Set<string>();
  const spawn: SpawnWorker = (request, onMessage) => {
    if (spawnThrows || (request.release.name === "b" && releaseBGone))
      throw new Error(`ENOENT: no such directory ${request.release.root}`);
    const exited = Promise.withResolvers<number | null>();
    const fake: Fake = {
      pid: 100 + fakes.length,
      processId: request.processId,
      release: request.release.name,
      alive: true,
      readySent: false,
      terminating: false,
      holding: new Set(),
      waiting: new Set(),
      nextRequest: 1,
      asked: [],
      say: (message) => {
        if (fake.alive) onMessage(message);
      },
      exit: (code) => {
        if (!fake.alive) return;
        fake.alive = false;
        if (fake.holding.size) unsettled.add(fake.processId);
        exited.resolve(code);
      },
    };
    fakes.push(fake);
    return {
      pid: fake.pid,
      send(message: SupervisorMessage) {
        if (!fake.alive) return;
        if (message.kind === "scopes-granted") {
          fake.waiting.delete(message.id);
          fake.holding.add(message.id);
        }
        if (message.kind === "recover")
          fake.asked.push({
            id: message.id,
            owner: message.owner,
            grants: message.fence.map((held) => held.grant),
          });
      },
      kill(signal) {
        if (!fake.alive) return;
        if (signal === "SIGKILL") fake.exit(null);
        else fake.terminating = true;
      },
      exited: exited.promise,
    };
  };
  const supervisor = createSupervisor({
    run: { id: "run-0123456789abcdef", startedAt: 1 },
    spawn,
    settings,
    release: (name) => {
      const found =
        name === null || name === "a"
          ? releases.a
          : name === "b" && !releaseBGone
            ? releases.b
            : undefined;
      return found
        ? { ok: true, release: found }
        : { ok: false, reason: `there is no release ${name}` };
    },
    distOf: (release) => `${release.root}/apps/web/dist`,
    log: () => undefined,
    clock,
  });
  let stopped = false;
  let started = false;
  const settled: Promise<unknown>[] = [];

  const fail = (why: string) => {
    throw new Error(
      `Supervisor model, seed ${seed}: ${why}\nstatus: ${JSON.stringify(supervisor.status())}\nworkers: ${JSON.stringify(fakes.map(({ pid, release, alive, readySent, terminating }) => ({ pid, release, alive, readySent, terminating })))}\nlast events:\n  ${history.slice(-25).join("\n  ")}`,
    );
  };

  function check() {
    const status = supervisor.status();
    reached(`phase ${status.phase}`);
    if (status.recovering.some((one) => one.fenced > 0))
      reached("fenced recovery");
    if (status.draining.length >= 2) reached("two drainers");
    const live = fakes.filter((fake) => fake.alive);
    const byPid = (pid: number | undefined) =>
      fakes.find((fake) => fake.pid === pid);
    const tracked = new Set(
      [
        status.active?.pid,
        status.starting?.pid,
        ...status.draining.map((drainer) => drainer.pid),
      ].filter((pid): pid is number => pid !== undefined),
    );
    for (const fake of live)
      if (!tracked.has(fake.pid))
        fail(`live worker ${fake.pid} is not tracked`);
    for (const pid of tracked)
      if (!byPid(pid)?.alive) fail(`worker ${pid} is tracked but dead`);
    const active = byPid(status.active?.pid);
    if (status.active && !active?.readySent)
      fail(`active worker ${status.active.pid} never reported ready`);
    if (
      status.active &&
      status.draining.some((d) => d.pid === status.active?.pid)
    )
      fail("the active worker is also draining");
    switch (status.phase) {
      case "serving":
      case "handing-over":
        if (!status.active) fail(`${status.phase} without an active worker`);
        break;
      case "starting":
        if (!status.starting) fail("starting without a candidate");
        break;
      case "restarting":
      case "full-restart":
        if (!clock.pending) fail(`${status.phase} with nothing pending`);
        break;
      case "idle":
      case "stopping":
        break;
    }
    // Nothing waits forever: while nobody serves, some timer is always pending, unless the
    // supervisor has stopped for good with nothing left running.
    const finished = status.phase === "stopping" && live.length === 0;
    if (!status.active && !finished && !clock.pending)
      fail("nobody serves and no timer is pending");
    if (status.phase === "stopping") stopped = true;
    // Fences: for every dead worker that held scopes until it is settled, and no one else.
    for (const recovery of status.recovering)
      if (
        recovery.fenced > 0 &&
        fakes.some((f) => f.processId === recovery.owner && f.alive)
      )
        fail(`a live worker ${recovery.owner} is fenced`);
    // Its fence may already be released grant by grant, but its recovery stays until settled.
    for (const owner of unsettled)
      if (!status.recovering.some((r) => r.owner === owner))
        fail(
          `dead worker ${owner} held scopes but nobody is to settle its changes`,
        );
  }

  const say = (fake: Fake, message: WorkerMessage) => {
    history.push(`${fake.pid} says ${JSON.stringify(message)}`);
    fake.say(message);
  };

  // Sometimes even the first worker cannot be started.
  spawnThrows = random.chance(0.05);
  settled.push(supervisor.start());
  started = true;
  history.push("start");
  await flush();
  check();

  for (let step = 0; step < STEPS; step++) {
    const live = fakes.filter((fake) => fake.alive);
    const options: (() => void)[] = [];
    for (const fake of live) {
      if (!fake.readySent && !fake.terminating)
        options.push(() => {
          fake.readySent = true;
          say(fake, { kind: "ready", build: null, startupMs: 1 });
        });
      if (!fake.readySent)
        options.push(() => {
          // Ready and gone before anything else runs.
          fake.readySent = true;
          say(fake, { kind: "ready", build: null, startupMs: 1 });
          history.push(`${fake.pid} exits right after ready`);
          fake.exit(1);
        });
      options.push(() => {
        const code = random.chance(0.3) ? 0 : 1;
        history.push(`${fake.pid} exits ${code}`);
        fake.exit(code);
      });
      if (!fake.readySent)
        options.push(() => {
          say(fake, { kind: "needs-full-restart", reason: "unsafe migration" });
          history.push(`${fake.pid} exits 75`);
          fake.exit(75);
        });
      if (fake.readySent)
        options.push(() => {
          const id = fake.nextRequest++;
          fake.waiting.add(id);
          const path = ["docs", "docs/a", "photos", ""][random.below(4)] ?? "";
          say(fake, {
            kind: "acquire-scopes",
            id,
            scopes: [{ space: "drive", path }],
          });
        });
      const [held] = [...fake.holding];
      if (held !== undefined)
        options.push(() => {
          fake.holding.delete(held);
          say(fake, { kind: "release-scopes", id: held });
        });
      const [asked] = fake.asked;
      const [grant] = asked?.grants ?? [];
      if (asked && grant !== undefined)
        options.push(() => {
          asked.grants.shift();
          say(fake, { kind: "fence-release", id: asked.id, grant });
        });
      if (asked)
        options.push(() => {
          fake.asked.shift();
          say(fake, { kind: "recovered", id: asked.id });
          unsettled.delete(asked.owner);
        });
    }
    if (clock.pending)
      options.push(() => {
        history.push(`clock fires at ${clock.time}`);
        clock.fireNext();
      });
    if (!stopped) {
      options.push(() => {
        const name = [null, "a", "b", "missing"][random.below(4)] ?? null;
        history.push(`handover ${name}`);
        settled.push(supervisor.handover(name));
      });
      options.push(() => {
        spawnThrows = !spawnThrows;
        history.push(`spawn ${spawnThrows ? "throws" : "works"}`);
      });
      options.push(() => {
        releaseBGone = !releaseBGone;
        history.push(`release b ${releaseBGone ? "removed" : "back"}`);
      });
      if (step > STEPS * 0.8 && random.chance(0.2))
        options.push(() => {
          stopped = true;
          history.push("stop");
          settled.push(supervisor.stop());
        });
    }
    const chosen = options[random.below(options.length)];
    if (!chosen) break;
    chosen();
    reached(
      `event ${(history.at(-1) ?? "")
        .replace(/^\d+ /, "")
        .replace(/\{.*"kind":"([\w-]+)".*\}/, "$1")
        .replace(/ \d+$/, "")
        .slice(0, 40)}`,
    );
    await flush();
    check();
  }
  // Run every timer out: whatever remains must end without anything waiting forever.
  spawnThrows = false;
  for (let rounds = 0; rounds < 200 && clock.fireNext(); rounds++) {
    history.push(`drain: clock fires at ${clock.time}`);
    for (const fake of fakes) if (fake.alive && fake.terminating) fake.exit(0);
    await flush();
    check();
  }
  expect(started).toBe(true);
  await Promise.allSettled(settled);
}

test(`the supervisor keeps its invariants over ${ONLY ? "one" : SEEDS} random sequences`, async () => {
  const seeds = ONLY
    ? [Number(ONLY)]
    : Array.from({ length: SEEDS }, (_, index) => index + 1);
  for (const seed of seeds) await runSequence(seed);
  if (process.env.SUPERVISOR_MODEL_COVERAGE)
    console.info(
      [...coverage]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([what, count]) => `${what}: ${count}`)
        .join("\n"),
    );
}, 600_000);
