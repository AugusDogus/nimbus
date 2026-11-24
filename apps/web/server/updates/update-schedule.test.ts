import { expect, test } from "bun:test";
import { UpdateSchedule } from "./update-schedule";

/** 2026-11-24 at `hour`:`minute`, in this process's time zone. */
const at = (hour: number, minute = 0) => new Date(2026, 10, 24, hour, minute);
const iso = (date: Date) => date.toISOString();

test("off never checks or installs on its own", () => {
  expect(
    UpdateSchedule.due({
      now: at(4),
      schedule: { mode: "off", hour: 4 },
      lastCheckAt: null,
      lastAutomatic: null,
      offered: true,
    }),
  ).toBeNull();
});

test("notify only checks when the last check is half a day old or missing, and never installs", () => {
  const schedule = { mode: "notify", hour: 4 } as const;
  expect(
    UpdateSchedule.due({
      now: at(12),
      schedule,
      lastCheckAt: null,
      lastAutomatic: null,
      offered: false,
    }),
  ).toEqual({ kind: "check" });
  expect(
    UpdateSchedule.due({
      now: at(12),
      schedule,
      lastCheckAt: iso(at(2)),
      lastAutomatic: null,
      offered: true,
    }),
  ).toBeNull();
  expect(
    UpdateSchedule.due({
      now: at(15),
      schedule,
      lastCheckAt: iso(at(2)),
      lastAutomatic: null,
      offered: true,
    }),
  ).toEqual({ kind: "check" });
  // At the quiet hour too: notify only never installs.
  expect(
    UpdateSchedule.due({
      now: at(4, 30),
      schedule,
      lastCheckAt: iso(at(4, 20)),
      lastAutomatic: null,
      offered: true,
    }),
  ).toBeNull();
});

test("install at the quiet hour checks afresh, installs what is offered, and tries once a day", () => {
  const schedule = { mode: "install", hour: 4 } as const;
  const day = UpdateSchedule.day(at(4));
  // Outside the hour it only checks, as notify does.
  expect(
    UpdateSchedule.due({
      now: at(3, 50),
      schedule,
      lastCheckAt: iso(at(3)),
      lastAutomatic: null,
      offered: true,
    }),
  ).toBeNull();
  // In the hour, an older check is made again first.
  expect(
    UpdateSchedule.due({
      now: at(4, 5),
      schedule,
      lastCheckAt: iso(at(3)),
      lastAutomatic: null,
      offered: true,
    }),
  ).toEqual({ kind: "check" });
  expect(
    UpdateSchedule.due({
      now: at(4, 6),
      schedule,
      lastCheckAt: iso(at(4, 5)),
      lastAutomatic: null,
      offered: true,
    }),
  ).toEqual({ kind: "install", day });
  expect(
    UpdateSchedule.due({
      now: at(4, 6),
      schedule,
      lastCheckAt: iso(at(4, 5)),
      lastAutomatic: null,
      offered: false,
    }),
  ).toBeNull();
  // Once tried today, not again, whatever came of it.
  expect(
    UpdateSchedule.due({
      now: at(4, 40),
      schedule,
      lastCheckAt: iso(at(4, 5)),
      lastAutomatic: day,
      offered: true,
    }),
  ).toBeNull();
});

test("a schedule is parsed from what an administrator sent, or refused", () => {
  expect(UpdateSchedule.parse({ mode: "install", hour: 23 })).toEqual({
    mode: "install",
    hour: 23,
  });
  for (const value of [
    { mode: "always", hour: 4 },
    { mode: "install", hour: 24 },
    { mode: "install", hour: 1.5 },
    null,
  ])
    expect(UpdateSchedule.parse(value)).toBeNull();
  expect(UpdateSchedule.standard).toEqual({ mode: "notify", hour: 4 });
});
