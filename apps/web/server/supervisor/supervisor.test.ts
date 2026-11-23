import { describe, expect, test } from "bun:test";
import type { SupervisorMessage, WorkerMessage } from "./protocol";
import {
  createSupervisor,
  type Release,
  type SpawnWorker,
  type SupervisorSettings,
} from "./supervisor";

type Fake = {
  release: string;
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
  restartMs: { initial: 10, max: 40 },
};

function harness(overrides: Partial<SupervisorSettings> = {}) {
  const workers: Fake[] = [];
  const lines: string[] = [];
  let clock = 1_000_000;
  const spawn: SpawnWorker = (request, onMessage) => {
    const exited = Promise.withResolvers<number | null>();
    const fake: Fake = {
      release: request.release.name,
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
    release: (name) => (name === null ? releases.a : releases[name]) ?? null,
    distOf: (release) => `${release.root}/apps/web/dist`,
    log: (line) => void lines.push(line),
    now: () => clock,
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
  test("starts one worker that serves alone", async () => {
    const h = harness();
    const first = await h.serving();
    expect(first.predecessor).toBe(false);
    expect(h.kinds(first)).toEqual(["active", "alone"]);
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
    // Once the drained worker is gone, the new one runs alone.
    first.exit(0);
    await Bun.sleep(1);
    expect(h.kinds(second)).toEqual(["active", "alone"]);
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
    expect(h.kinds(first)).toEqual(["active", "alone"]);
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
    expect(h.kinds(first)).toEqual(["active", "alone"]);
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

  test("releases what a worker held when it exits", async () => {
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
    expect(second.sent.some((m) => m.kind === "scopes-granted")).toBe(false);
    first.exit(1);
    await Bun.sleep(1);
    expect(second.sent).toContainEqual({ kind: "scopes-granted", id: 1 });
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

  test("starts a crashed active worker again, waiting for drainers before recovery", async () => {
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
    expect(h.kinds(restarted)).toEqual(["active"]);
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
    // The dead worker never drains, so the candidate runs alone.
    expect(first.sent.filter((m) => m.kind === "drain")).toEqual([]);
    expect(h.kinds(candidate)).toEqual(["active", "alone"]);
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
});
