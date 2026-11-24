import { describe, expect, test } from "bun:test";
import {
  RELEASE_REFUSED_EXIT,
  type SupervisorMessage,
  type WorkerMessage,
} from "./protocol";
import {
  createSupervisor,
  realClock,
  type Release,
  type SpawnWorker,
  type SupervisorSettings,
} from "./supervisor";

type Fake = {
  release: string;
  processId: string;
  predecessor: boolean;
  previousAssets: string[];
  pid: number;
  sent: SupervisorMessage[];
  killed: string[];
  say: (message: WorkerMessage) => void;
  exit: (code: number | null) => void;
};

const releases: Record<string, Release> = {
  a: { name: "a", root: "/releases/a" },
  b: { name: "b", root: "/releases/b" },
};

const settings: SupervisorSettings = {
  readyTimeoutMs: 200,
  drainMs: 60_000,
  maxDraining: 2,
  stopMs: 1_000,
  killGraceMs: 5_000,
  restartMs: { initial: 10, max: 40 },
};

function harness(
  overrides: Partial<SupervisorSettings> = {},
  spawnFails: () => boolean = () => false,
) {
  const workers: Fake[] = [];
  const lines: string[] = [];
  /** Every release that became active, in order, as the supervisor reports it. */
  const activated: string[] = [];
  let clock = 1_000_000;
  const spawn: SpawnWorker = (request, onMessage) => {
    if (spawnFails())
      throw new Error(`ENOENT: no such directory ${request.release.root}`);
    const exited = Promise.withResolvers<number | null>();
    const fake: Fake = {
      release: request.release.name,
      processId: request.processId,
      predecessor: request.predecessor,
      previousAssets: request.previousAssets,
      pid: 100 + workers.length,
      sent: [],
      killed: [],
      // IPC messages arrive asynchronously.
      say: (message) => queueMicrotask(() => onMessage(message)),
      exit: (code) => exited.resolve(code),
    };
    workers.push(fake);
    return {
      pid: fake.pid,
      send: (message) => void fake.sent.push(message),
      kill(signal) {
        fake.killed.push(signal);
        fake.exit(null);
      },
      exited: exited.promise,
    };
  };
  const supervisor = createSupervisor({
    run: { id: "run-0123456789abcdef", startedAt: 1 },
    spawn,
    settings: { ...settings, ...overrides },
    release: (name) => {
      const found = name === null ? releases.a : releases[name];
      return found
        ? { ok: true, release: found }
        : { ok: false, reason: `there is no release ${name}` };
    },
    distOf: (release) => `${release.root}/apps/web/dist`,
    builtIn: releases.a,
    log: (line) => void lines.push(line),
    onActive: (release) => void activated.push(release.name),
    clock: { now: () => clock, after: realClock.after },
  });
  const ready = (fake: Fake | undefined) =>
    fake?.say({ kind: "ready", build: "/assets/index.js", startupMs: 5 });
  /** Wait until worker `index` has been started. */
  const started = async (index: number) => {
    for (let tries = 0; !workers[index] && tries < 100; tries++)
      await Bun.sleep(1);
    const fake = workers[index];
    if (!fake) throw new Error(`worker ${index} was not started`);
    return fake;
  };
  const kinds = (fake: Fake) => fake.sent.map((message) => message.kind);
  return {
    supervisor,
    workers,
    lines,
    activated,
    started,
    ready,
    kinds,
    advance: (ms: number) => void (clock += ms),
    now: () => clock,
    /** Start the supervisor with worker 0 of release `a` ready. */
    async serving() {
      const starting = supervisor.start();
      ready(await started(0));
      expect((await starting).ok).toBe(true);
      return await started(0);
    },
    /** Hand over to `name` with the new worker ready. */
    async handover(name: string | null, index: number) {
      const handing = supervisor.handover(name);
      ready(await started(index));
      const outcome = await handing;
      if (!outcome.ok) throw new Error(outcome.error.message);
      return outcome.value;
    },
  };
}

describe("the supervisor", () => {
  test("starts one worker that serves", async () => {
    const h = harness();
    const first = await h.serving();
    expect(first.predecessor).toBe(false);
    expect(h.kinds(first)).toEqual(["active"]);
    expect(h.supervisor.status()).toMatchObject({
      phase: "serving",
      active: { release: "a", pid: first.pid },
      starting: null,
      draining: [],
    });
  });

  test("hands over: the next worker starts beside the active one, which then drains", async () => {
    const h = harness();
    const first = await h.serving();
    const report = await h.handover("b", 1);
    const second = h.workers[1];
    if (!second) throw new Error("no second worker");
    expect(second.predecessor).toBe(true);
    // The replaced release's assets stay servable by the next one.
    expect(second.previousAssets).toEqual(["/releases/a/apps/web/dist"]);
    expect(report).toMatchObject({ from: "a", to: "b" });
    expect(first.sent.at(-1)).toEqual({
      kind: "drain",
      deadline: h.now() + settings.drainMs,
    });
    expect(h.kinds(second)).toEqual(["active"]);
    expect(h.supervisor.status()).toMatchObject({
      active: { release: "b", pid: second.pid },
      draining: [
        {
          release: "a",
          pid: first.pid,
          deadlineReason: "drain timeout",
          inFlight: null,
        },
      ],
    });
    first.say({ kind: "in-flight", count: 3 });
    await Bun.sleep(1);
    expect(h.supervisor.status().draining[0]?.inFlight).toBe(3);
    // Once the drained worker is gone, the new one settles anything it left unfinished.
    first.exit(0);
    await Bun.sleep(1);
    expect(second.sent.at(-1)).toEqual({
      kind: "recover",
      id: 1,
      owner: first.processId,
      fence: [],
    });
    expect(h.supervisor.status().draining).toEqual([]);
  });

  test("restarts in place with a fresh worker of the same release", async () => {
    const h = harness();
    await h.serving();
    const report = await h.handover(null, 1);
    expect(report).toMatchObject({ from: "a", to: "a" });
    expect(h.workers[1]?.previousAssets).toEqual([]);
  });

  test("keeps the active worker when the next one exits before it is ready", async () => {
    const h = harness();
    const first = await h.serving();
    const handing = h.supervisor.handover("b");
    (await h.started(1)).exit(1);
    const outcome = await handing;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe("not-ready");
    // The failed candidate may have recorded changes before it died; the active worker settles them.
    expect(h.kinds(first)).toEqual(["active", "recover"]);
    expect(h.supervisor.status()).toMatchObject({
      active: { release: "a", pid: first.pid },
      starting: null,
      draining: [],
    });
  });

  test("stops a next worker that is not ready in time, keeping the active one", async () => {
    const h = harness();
    const first = await h.serving();
    const outcome = await h.supervisor.handover("b");
    expect(outcome.ok).toBe(false);
    expect(h.workers[1]?.killed).toEqual(["SIGTERM"]);
    // The failed candidate may have recorded changes before it died; the active worker settles them.
    expect(h.kinds(first)).toEqual(["active", "recover"]);
  });

  test("refuses an unknown release and a second handover while one runs", async () => {
    const h = harness();
    await h.serving();
    const unknown = await h.supervisor.handover("missing");
    expect(unknown.ok ? null : unknown.error.kind).toBe("unknown-release");
    const running = h.supervisor.handover("b");
    await h.started(1);
    const second = await h.supervisor.handover("b");
    expect(second.ok ? null : second.error.kind).toBe("busy");
    h.ready(h.workers[1]);
    expect((await running).ok).toBe(true);
  });

  test("bounds draining workers: one more makes the oldest finish now", async () => {
    const h = harness();
    const first = await h.serving();
    await h.handover("b", 1);
    h.advance(1000);
    await h.handover("a", 2);
    h.advance(1000);
    expect(first.sent.filter((m) => m.kind === "drain")).toHaveLength(1);
    await h.handover("b", 3);
    expect(first.sent.at(-1)).toEqual({ kind: "drain", deadline: h.now() });
    const draining = h.supervisor.status().draining;
    expect(draining.map((worker) => worker.deadlineReason)).toEqual([
      "drain limit",
      "drain timeout",
      "drain timeout",
    ]);
  });

  test("grants path scopes across workers, so overlapping changes wait", async () => {
    const h = harness();
    const first = await h.serving();
    await h.handover("b", 1);
    const second = h.workers[1];
    if (!second) throw new Error("no second worker");
    first.say({
      kind: "acquire-scopes",
      id: 1,
      scopes: [{ space: "drive", path: "docs" }],
    });
    await Bun.sleep(1);
    expect(first.sent.at(-1)).toEqual({ kind: "scopes-granted", id: 1 });
    second.say({
      kind: "acquire-scopes",
      id: 1,
      scopes: [{ space: "drive", path: "docs/report.txt" }],
    });
    second.say({
      kind: "acquire-scopes",
      id: 2,
      scopes: [{ space: "drive", path: "photos" }],
    });
    await Bun.sleep(1);
    // Disjoint paths go ahead; overlapping ones wait for the other worker.
    expect(second.sent.filter((m) => m.kind === "scopes-granted")).toEqual([
      { kind: "scopes-granted", id: 2 },
    ]);
    first.say({ kind: "release-scopes", id: 1 });
    await Bun.sleep(1);
    expect(second.sent.filter((m) => m.kind === "scopes-granted")).toEqual([
      { kind: "scopes-granted", id: 2 },
      { kind: "scopes-granted", id: 1 },
    ]);
  });

  test("keeps a dead worker's scopes fenced until the active worker settled the changes in them", async () => {
    const h = harness();
    const first = await h.serving();
    await h.handover("b", 1);
    const second = h.workers[1];
    if (!second) throw new Error("no second worker");
    first.say({
      kind: "acquire-scopes",
      id: 7,
      scopes: [{ space: "trash", path: "" }],
    });
    await Bun.sleep(1);
    second.say({
      kind: "acquire-scopes",
      id: 1,
      scopes: [{ space: "trash", path: "item-1" }],
    });
    await Bun.sleep(1);
    first.exit(1);
    await Bun.sleep(1);
    // Its change in progress may be half done: nobody else gets its paths yet.
    expect(second.sent.some((m) => m.kind === "scopes-granted")).toBe(false);
    expect(second.sent.at(-1)).toEqual({
      kind: "recover",
      id: 1,
      owner: first.processId,
      fence: [{ grant: 7, scopes: [{ space: "trash", path: "" }] }],
    });
    second.say({ kind: "fence-release", id: 1, grant: 7 });
    await Bun.sleep(1);
    expect(second.sent.at(-1)).toEqual({ kind: "scopes-granted", id: 1 });
    // Released, but its changes outside the fence may still be unsettled.
    expect(h.supervisor.status().recovering).toEqual([
      { owner: first.processId, fenced: 0 },
    ]);
    second.say({ kind: "recovered", id: 1 });
    await Bun.sleep(1);
    expect(h.supervisor.status().recovering).toEqual([]);
  });

  test("asks the next active worker again when the one settling exits before it is done", async () => {
    const h = harness();
    const first = await h.serving();
    await h.handover("b", 1);
    const second = h.workers[1];
    if (!second) throw new Error("no second worker");
    first.exit(1);
    await Bun.sleep(1);
    second.say({
      kind: "acquire-scopes",
      id: 3,
      scopes: [{ space: "drive", path: "docs" }],
    });
    await Bun.sleep(1);
    // Waiting for a scope outside the fence, it exits: the first worker's changes still count.
    second.exit(1);
    const third = await h.started(2);
    h.ready(third);
    await Bun.sleep(1);
    const owners = third.sent.flatMap((m) =>
      m.kind === "recover" ? [m.owner] : [],
    );
    expect(owners).toEqual([first.processId, second.processId]);
  });

  test("asks the next active worker again when the one recovering dies first", async () => {
    const h = harness();
    const first = await h.serving();
    await h.handover("b", 1);
    const second = h.workers[1];
    if (!second) throw new Error("no second worker");
    first.exit(1);
    await Bun.sleep(1);
    expect(second.sent.at(-1)).toMatchObject({
      kind: "recover",
      owner: first.processId,
    });
    second.exit(1);
    const third = await h.started(2);
    h.ready(third);
    await Bun.sleep(1);
    const asked = third.sent.filter((m) => m.kind === "recover");
    expect(asked.map((m) => (m.kind === "recover" ? m.owner : ""))).toEqual([
      first.processId,
      second.processId,
    ]);
  });

  test("passes transfer signals to every other worker", async () => {
    const h = harness();
    const first = await h.serving();
    await h.handover("b", 1);
    const second = h.workers[1];
    if (!second) throw new Error("no second worker");
    const signal = { kind: "devices-ended" as const, deviceIds: ["device-1"] };
    second.say({ kind: "transfer-signal", signal });
    await Bun.sleep(1);
    expect(first.sent.at(-1)).toEqual({ kind: "transfer-signal", signal });
    expect(second.sent.some((m) => m.kind === "transfer-signal")).toBe(false);
  });

  test("starts a crashed active worker again beside the drainers, to settle what it left", async () => {
    const h = harness();
    await h.serving();
    await h.handover("b", 1);
    const second = h.workers[1];
    second?.exit(1);
    const restarted = await h.started(2);
    expect(restarted.release).toBe("b");
    // The first worker still drains, so the restarted one has a predecessor.
    expect(restarted.predecessor).toBe(true);
    h.ready(restarted);
    await Bun.sleep(1);
    expect(h.kinds(restarted)).toEqual(["active", "recover"]);
    expect(h.supervisor.status().active?.pid).toBe(restarted.pid);
  });

  test("when the active worker dies during a handover, the candidate takes over and nothing else starts", async () => {
    const h = harness();
    const first = await h.serving();
    const handing = h.supervisor.handover("b");
    const candidate = await h.started(1);
    first.exit(1);
    // Longer than the restart wait: no fallback may start while the candidate gets ready.
    await Bun.sleep(60);
    expect(h.workers).toHaveLength(2);
    h.ready(candidate);
    const outcome = await handing;
    expect(outcome.ok).toBe(true);
    await Bun.sleep(1);
    expect(h.supervisor.status()).toMatchObject({
      phase: "serving",
      active: { release: "b", pid: candidate.pid },
      draining: [],
    });
    // The dead worker never drains; the candidate settles what it left unfinished.
    expect(first.sent.filter((m) => m.kind === "drain")).toEqual([]);
    expect(candidate.sent).toEqual([
      { kind: "active" },
      { kind: "recover", id: 1, owner: first.processId, fence: [] },
    ]);
  });

  test("when the active worker dies and the candidate then fails, one fallback starts", async () => {
    const h = harness();
    const first = await h.serving();
    const handing = h.supervisor.handover("b");
    const candidate = await h.started(1);
    first.exit(1);
    await Bun.sleep(5);
    candidate.exit(1);
    expect((await handing).ok).toBe(false);
    const fallback = await h.started(2);
    expect(fallback.release).toBe("a");
    expect(fallback.predecessor).toBe(false);
    h.ready(fallback);
    await Bun.sleep(1);
    expect(h.supervisor.status()).toMatchObject({
      phase: "serving",
      active: { pid: fallback.pid },
    });
    await Bun.sleep(60);
    expect(h.workers).toHaveLength(3);
  });

  test("a crashed worker that never gets ready is started again, never two at once", async () => {
    const h = harness();
    const first = await h.serving();
    first.exit(1);
    const second = await h.started(1);
    second.exit(1);
    const third = await h.started(2);
    expect(h.workers).toHaveLength(3);
    h.ready(third);
    await Bun.sleep(1);
    expect(h.supervisor.status().active?.pid).toBe(third.pid);
    await Bun.sleep(100);
    expect(h.workers).toHaveLength(3);
  });

  test("a first worker that never gets ready is stopped after the ready time", async () => {
    const h = harness();
    const starting = h.supervisor.start();
    const first = await h.started(0);
    const outcome = await starting;
    expect(outcome.ok).toBe(false);
    expect(first.killed).toEqual(["SIGTERM"]);
  });

  test("a restarted worker that never gets ready is stopped and tried again", async () => {
    const h = harness();
    const first = await h.serving();
    first.exit(1);
    const stuck = await h.started(1);
    await Bun.sleep(settings.readyTimeoutMs + 50);
    expect(stuck.killed).toEqual(["SIGTERM"]);
    const again = await h.started(2);
    h.ready(again);
    await Bun.sleep(1);
    expect(h.supervisor.status().active?.pid).toBe(again.pid);
  });

  test("a drainer still running after its deadline is killed by the supervisor", async () => {
    const h = harness({ drainMs: 30, killGraceMs: 20 });
    const first = await h.serving();
    await h.handover("b", 1);
    expect(first.killed).toEqual([]);
    await Bun.sleep(100);
    expect(first.killed).toEqual(["SIGKILL"]);
    expect(h.supervisor.status().draining).toEqual([]);
  });

  test("the oldest drainer, told to finish at the drain limit, is killed if it does not", async () => {
    const h = harness({ killGraceMs: 20 });
    const first = await h.serving();
    await h.handover("b", 1);
    await h.handover("a", 2);
    await h.handover("b", 3);
    await Bun.sleep(60);
    expect(first.killed).toEqual(["SIGKILL"]);
    expect(h.workers[1]?.killed).toEqual([]);
  });

  test("a release whose migrations are not safe beside the old server gets a full restart", async () => {
    const h = harness();
    const first = await h.serving();
    const handing = h.supervisor.handover("b");
    const candidate = await h.started(1);
    candidate.say({
      kind: "needs-full-restart",
      reason: "its migration 0022_rename is not declared safe",
    });
    candidate.exit(0);
    await Bun.sleep(1);
    // Every running worker stops, within the stop time, before the new release starts alone.
    expect(first.sent.at(-1)).toEqual({
      kind: "drain",
      deadline: h.now() + settings.stopMs,
    });
    expect(h.workers).toHaveLength(2);
    first.exit(0);
    const fresh = await h.started(2);
    expect(fresh.release).toBe("b");
    expect(fresh.predecessor).toBe(false);
    h.ready(fresh);
    const outcome = await handing;
    expect(outcome.ok).toBe(true);
    if (outcome.ok)
      expect(outcome.value).toMatchObject({
        from: "a",
        to: "b",
        draining: null,
        fullRestart: "its migration 0022_rename is not declared safe",
      });
    expect(h.supervisor.status()).toMatchObject({
      phase: "serving",
      active: { pid: fresh.pid },
      draining: [],
    });
  });

  test("a candidate that exits with the full-restart code gets one even if its message was lost", async () => {
    const h = harness();
    const first = await h.serving();
    const handing = h.supervisor.handover("b");
    (await h.started(1)).exit(75);
    await Bun.sleep(1);
    first.exit(0);
    const fresh = await h.started(2);
    expect(fresh.predecessor).toBe(false);
    h.ready(fresh);
    const outcome = await handing;
    expect(outcome.ok && outcome.value.fullRestart).toContain("migrations");
  });

  test("a first worker that reports ready and exits at once is started again, never left active", async () => {
    const h = harness();
    const starting = h.supervisor.start();
    const first = await h.started(0);
    first.say({ kind: "ready", build: null, startupMs: 1 });
    queueMicrotask(() => first.exit(1));
    expect((await starting).ok).toBe(true);
    await Bun.sleep(1);
    expect(h.supervisor.status().phase).toBe("restarting");
    const again = await h.started(1);
    h.ready(again);
    await Bun.sleep(1);
    expect(h.supervisor.status().active?.pid).toBe(again.pid);
  });

  test("a candidate that reports ready and exits at once is replaced by a restart", async () => {
    const h = harness();
    const first = await h.serving();
    const handing = h.supervisor.handover("b");
    const candidate = await h.started(1);
    candidate.say({ kind: "ready", build: null, startupMs: 1 });
    queueMicrotask(() => candidate.exit(1));
    expect((await handing).ok).toBe(true);
    await Bun.sleep(1);
    // The old worker already left the port, so a fresh one of the candidate's release starts.
    expect(first.sent.some((m) => m.kind === "drain")).toBe(true);
    expect(h.supervisor.status().phase).toBe("restarting");
    const again = await h.started(2);
    expect(again.release).toBe("b");
  });

  test("a release directory that vanished during a full restart's drain is retried, not waited on", async () => {
    let gone = false;
    const h = harness({}, () => gone);
    const first = await h.serving();
    const handing = h.supervisor.handover("b");
    const candidate = await h.started(1);
    candidate.say({ kind: "needs-full-restart", reason: "unsafe" });
    candidate.exit(75);
    await Bun.sleep(1);
    gone = true;
    first.exit(0);
    expect((await handing).ok).toBe(false);
    expect(h.supervisor.status().phase).toBe("restarting");
    gone = false;
    const retried = await h.started(2);
    expect(retried.predecessor).toBe(false);
  });

  test("after a full restart, a new release that fails is retried, never replaced by the old one", async () => {
    const h = harness();
    const first = await h.serving();
    const handing = h.supervisor.handover("b");
    const candidate = await h.started(1);
    candidate.say({ kind: "needs-full-restart", reason: "unsafe" });
    candidate.exit(75);
    await Bun.sleep(1);
    first.exit(0);
    // It may have applied migrations the old release cannot run before it failed.
    const fresh = await h.started(2);
    fresh.exit(1);
    expect((await handing).ok).toBe(false);
    const retried = await h.started(3);
    expect(retried.release).toBe("b");
    retried.exit(1);
    const again = await h.started(4);
    expect(again.release).toBe("b");
    expect(
      h.lines.some((line) => line.includes("restore the pre-migration backup")),
    ).toBe(true);
  });

  test("reports every worker that becomes active, a full restart's retry included", async () => {
    const h = harness();
    const first = await h.serving();
    await h.handover("b", 1);
    expect(h.activated).toEqual(["a", "b"]);
    const handing = h.supervisor.handover("a");
    const candidate = await h.started(2);
    candidate.say({ kind: "needs-full-restart", reason: "unsafe" });
    candidate.exit(75);
    await Bun.sleep(1);
    // Every server stops first, the one still draining from the first handover too.
    first.exit(0);
    h.workers[1]?.exit(0);
    const fresh = await h.started(3);
    fresh.exit(1);
    expect((await handing).ok).toBe(false);
    // The retry takes over later, with no caller waiting: it is reported all the same.
    const retried = await h.started(4);
    h.ready(retried);
    for (let tries = 0; h.activated.length < 3 && tries < 100; tries++)
      await Bun.sleep(1);
    expect(h.activated).toEqual(["a", "b", "a"]);
  });

  test("stops by draining every worker within the stop time", async () => {
    const h = harness();
    const first = await h.serving();
    await h.handover("b", 1);
    const second = h.workers[1];
    if (!second) throw new Error("no second worker");
    const stopping = h.supervisor.stop();
    const deadline = h.now() + settings.stopMs;
    // The draining worker's deadline comes forward; the active one starts draining.
    expect(first.sent.at(-1)).toEqual({ kind: "drain", deadline });
    expect(second.sent.at(-1)).toEqual({ kind: "drain", deadline });
    expect(h.supervisor.status().phase).toBe("stopping");
    const refused = await h.supervisor.handover("a");
    expect(refused.ok ? null : refused.error.kind).toBe("busy");
    first.exit(0);
    second.exit(0);
    await stopping;
  });

  test("a reserved handover makes every other one busy until it ends, and a busy one starts nothing", async () => {
    const h = harness();
    await h.serving();
    const reserved = h.supervisor.reserve();
    if (!reserved.ok) throw new Error(reserved.error.message);
    // Another restart, update or rollback meanwhile: busy, and nothing starts.
    for (const name of ["b", null]) {
      const other = await h.supervisor.handover(name);
      expect(other.ok || other.error.kind).toBe("busy");
    }
    expect(h.supervisor.reserve().ok).toBe(false);
    expect(h.workers).toHaveLength(1);
    // The owner hands over with its reservation, which ends with the handover.
    const handing = h.supervisor.handover("b", reserved.value);
    h.ready(await h.started(1));
    expect((await handing).ok).toBe(true);
    const next = h.supervisor.reserve();
    expect(next.ok).toBe(true);
    // One given up changes nothing either, and frees the supervisor.
    if (next.ok) next.value.release();
    expect((await h.handover("a", 2)).to).toBe("a");
  });

  test("an installed release refused when it restarts falls back to the built-in one instead of being retried forever", async () => {
    const h = harness();
    await h.serving();
    await h.handover("b", 1);
    // It crashes, and at its restart its files no longer verify.
    h.workers[1]?.exit(1);
    const retried = await h.started(2);
    expect(retried.release).toBe("b");
    retried.exit(RELEASE_REFUSED_EXIT);
    const builtIn = await h.started(3);
    expect(builtIn.release).toBe("a");
    h.ready(builtIn);
    for (
      let tries = 0;
      tries < 100 && h.supervisor.status().phase !== "serving";
      tries++
    )
      await Bun.sleep(5);
    expect(h.supervisor.status().active?.release).toBe("a");
    expect(h.lines.join("\n")).toContain("built-in release");
  });

  test("a reserved handover waits through a crash restart instead of being refused after its owner wrote what it starts", async () => {
    const h = harness();
    await h.serving();
    const reserved = h.supervisor.reserve();
    if (!reserved.ok) throw new Error(reserved.error.message);
    // The active server crashes while the owner of the reservation records its target.
    h.workers[0]?.exit(1);
    await Bun.sleep(1);
    expect(h.supervisor.status().phase).toBe("restarting");
    const handing = h.supervisor.handover("b", reserved.value);
    h.ready(await h.started(1));
    h.ready(await h.started(2));
    const outcome = await handing;
    expect(outcome.ok).toBe(true);
    expect(h.supervisor.status().active?.release).toBe("b");
  });
});
