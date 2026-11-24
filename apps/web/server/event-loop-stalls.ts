/**
 * Stalls of this process's event loop: while it is blocked, every request and every stream this
 * server sends waits, a film included. A timer that should fire every `intervalMs` notices when
 * it fired late by more than `thresholdMs`, and one line is logged with how long the loop was
 * blocked and what was running.
 *
 * The server's own background jobs run through `track` with a label. The synchronous part of a
 * job, which is where it would block, is timed: a stall it covered is put down to it. Otherwise
 * the line names the jobs in progress, whose synchronous steps after an `await` are not timed,
 * or says that none was, which leaves a request or garbage collection.
 */
export type StallCause =
  | { kind: "job"; label: string; ms: number }
  | { kind: "in-progress"; labels: string[] }
  | { kind: "none" };

export type Stall = { ms: number; endedAt: number; cause: StallCause };

export type StallClock = {
  /** Milliseconds, monotonic. */
  now: () => number;
  /** Epoch milliseconds, for the log line. */
  wallNow: () => number;
  /** Run `tick` every `ms` until the returned function is called; it must not keep the process alive. */
  every: (ms: number, tick: () => void) => () => void;
};

const realClock: StallClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  every(ms, tick) {
    const timer = setInterval(tick, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

type Segment = { label: string; startedAt: number; endedAt: number };

/** Synchronous job segments this long are remembered, the last few of them. */
const rememberedMs = 50;
const remembered = 8;

let clock: StallClock = realClock;
let nextJob = 1;
const inProgress = new Map<number, string>();
const segments: Segment[] = [];

function remember(segment: Segment) {
  if (segment.endedAt - segment.startedAt < rememberedMs) return;
  segments.push(segment);
  if (segments.length > remembered) segments.shift();
}

/** What a stall from `from` to `to` (monotonic milliseconds) is put down to. */
function causeOf(from: number, to: number): StallCause {
  const length = to - from;
  let best: { segment: Segment; overlap: number } | null = null;
  for (const segment of segments) {
    const overlap =
      Math.min(segment.endedAt, to) - Math.max(segment.startedAt, from);
    if (overlap >= length / 2 && (!best || overlap > best.overlap))
      best = { segment, overlap };
  }
  if (best)
    return {
      kind: "job",
      label: best.segment.label,
      ms: Math.round(best.segment.endedAt - best.segment.startedAt),
    };
  const labels = [...new Set(inProgress.values())];
  return labels.length ? { kind: "in-progress", labels } : { kind: "none" };
}

const iso = (epoch: number) => new Date(epoch).toISOString();

export const EventLoopStalls = {
  /**
   * Run background job `label`. Its synchronous part is timed, and the job counts as in
   * progress until it returns or, for a promise, settles.
   */
  track<T>(label: string, job: () => T): T {
    const id = nextJob++;
    const startedAt = clock.now();
    inProgress.set(id, label);
    let result: T;
    try {
      result = job();
    } catch (error) {
      inProgress.delete(id);
      remember({ label, startedAt, endedAt: clock.now() });
      throw error;
    }
    remember({ label, startedAt, endedAt: clock.now() });
    if (result instanceof Promise)
      void result.then(
        () => inProgress.delete(id),
        () => inProgress.delete(id),
      );
    else inProgress.delete(id);
    return result;
  },

  /** The log line for `stall`, and for the `skipped` stalls not reported since the last one. */
  describe(stall: Stall, skipped: { count: number; longestMs: number }) {
    const during =
      stall.cause.kind === "job"
        ? `in the server's ${stall.cause.label}, which ran without yielding for ${stall.cause.ms} ms`
        : stall.cause.kind === "in-progress"
          ? `while these background jobs were in progress: ${stall.cause.labels.join(", ")}`
          : "while none of the server's background jobs was running, so in a request or in garbage collection";
    const since = skipped.count
      ? ` ${skipped.count} shorter or later stalls since the last report went unlogged, the longest ${skipped.longestMs} ms.`
      : "";
    return `Nimbus's event loop was blocked for ${stall.ms} ms, until ${iso(stall.endedAt)}, ${during}. Every request and stream on this server waited that long; files are unaffected. If this repeats, report this line.${since}`;
  },

  /**
   * Watch for stalls over `thresholdMs`, logging at most one line every `quietMs`. Returns a
   * function that stops watching.
   */
  start({
    thresholdMs = 1_000,
    intervalMs = 250,
    quietMs = 10_000,
    log = console.warn,
    using = realClock,
  }: {
    thresholdMs?: number;
    intervalMs?: number;
    quietMs?: number;
    log?: (line: string) => void;
    using?: StallClock;
  } = {}) {
    clock = using;
    // Remembered against the previous clock.
    segments.length = 0;
    let last = clock.now();
    let reportedAt = Number.NEGATIVE_INFINITY;
    let skipped = { count: 0, longestMs: 0 };
    const stop = clock.every(intervalMs, () => {
      const now = clock.now();
      const late = now - last - intervalMs;
      const from = last + intervalMs;
      last = now;
      if (late <= thresholdMs) return;
      const ms = Math.round(late);
      if (now - reportedAt < quietMs) {
        skipped = {
          count: skipped.count + 1,
          longestMs: Math.max(skipped.longestMs, ms),
        };
        return;
      }
      reportedAt = now;
      log(
        EventLoopStalls.describe(
          { ms, endedAt: clock.wallNow(), cause: causeOf(from, now) },
          skipped,
        ),
      );
      skipped = { count: 0, longestMs: 0 };
    });
    return () => {
      stop();
      clock = realClock;
    };
  },
} as const;
