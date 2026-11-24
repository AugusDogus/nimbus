import { afterEach, expect, test } from "bun:test";
import { EventLoopStalls, type StallClock } from "./event-loop-stalls";

/** A clock moved by hand; `tick` runs the monitor's timer as if it fired now. */
function manualClock() {
  let now = 0;
  let tick: () => void = () => undefined;
  const clock: StallClock = {
    now: () => now,
    wallNow: () => Date.UTC(2026, 0, 1) + now,
    every(_ms, run) {
      tick = run;
      return () => {
        tick = () => undefined;
      };
    },
  };
  return {
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => tick(),
    /** Time passing with the timer firing on time, as on a loop that is not blocked. */
    idle: (ms: number) => {
      for (let passed = 0; passed < ms; passed += 250) {
        now += 250;
        tick();
      }
    },
  };
}

let stop: () => void = () => undefined;
afterEach(() => stop());

function monitor() {
  const time = manualClock();
  const lines: string[] = [];
  stop = EventLoopStalls.start({
    using: time.clock,
    log: (line) => lines.push(line),
  });
  return { ...time, lines };
}

test("a stall inside a job's synchronous part names the job", () => {
  const { advance, tick, lines } = monitor();
  EventLoopStalls.track("file watch setup", () => advance(2_200));
  advance(250);
  tick();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("blocked for 2200 ms");
  expect(lines[0]).toContain(
    "in the server's file watch setup, which ran without yielding for 2200 ms",
  );
});

test("a stall while an asynchronous job is in progress lists it, and one after it settles does not", async () => {
  const { advance, tick, idle, lines } = monitor();
  const { promise, resolve } = Promise.withResolvers<void>();
  const job = EventLoopStalls.track("library catalog scan", () => promise);
  advance(1_500);
  tick();
  expect(lines[0]).toContain(
    "while these background jobs were in progress: library catalog scan",
  );
  resolve();
  await job;
  idle(10_000);
  advance(1_600);
  tick();
  expect(lines[1]).toContain(
    "while none of the server's background jobs was running",
  );
});

test("a short delay is not a stall", () => {
  const { advance, tick, lines } = monitor();
  advance(1_200);
  tick();
  expect(lines).toEqual([]);
});

test("at most one line every 10 seconds, the next one counting what went unlogged", () => {
  const { advance, tick, idle, lines } = monitor();
  advance(1_400);
  tick();
  advance(3_000);
  tick();
  advance(1_300);
  tick();
  expect(lines).toHaveLength(1);
  idle(10_000);
  advance(2_000);
  tick();
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(
    "2 shorter or later stalls since the last report went unlogged, the longest 2750 ms",
  );
});
