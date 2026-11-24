import { z } from "zod";

/**
 * When the supervisor looks for and installs updates on its own (see docs/updates.md):
 *
 * - `off`: never on its own; an administrator checks and installs in Settings.
 * - `notify`: checks twice a day, so Settings shows what is available; installs nothing. The
 *   default.
 * - `install`: checks as notify does, and at `hour` (0 to 23, in the server's time zone) checks
 *   again and installs what is offered, once a day, whatever came of the try.
 */
export type UpdateSchedule = {
  mode: "off" | "notify" | "install";
  hour: number;
};

/** What is due now: a check, or the day's automatic install. */
export type ScheduleDue = { kind: "check" } | { kind: "install"; day: string };

const schema = z.object({
  mode: z.enum(["off", "notify", "install"]),
  hour: z.number().int().min(0).max(23),
});

/** Notify only, with installs at 04:00 should an administrator choose them. */
const standard: UpdateSchedule = { mode: "notify", hour: 4 };

const HOUR_MS = 60 * 60 * 1000;
/** How old the last check may be before the next automatic one. */
const CHECK_EVERY_MS = 12 * HOUR_MS;
/** In the quiet hour, a check older than this is made again before installing. */
const FRESH_MS = 30 * 60 * 1000;

/** `date`'s calendar day in this process's time zone, as YYYY-MM-DD. */
function day(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const UpdateSchedule = {
  schema,
  standard,
  day,

  /** `value` as a schedule, or null when it is not one. */
  parse(value: unknown): UpdateSchedule | null {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },

  /** What the supervisor should do on its own now, if anything. */
  due({
    now,
    schedule,
    lastCheckAt,
    lastAutomatic,
    offered,
  }: {
    now: Date;
    schedule: UpdateSchedule;
    /** When the update source was last asked, as an ISO time. */
    lastCheckAt: string | null;
    /** The day (`day`) the last automatic install was tried. */
    lastAutomatic: string | null;
    /** Whether the last check offered a release this image can install. */
    offered: boolean;
  }): ScheduleDue | null {
    if (schedule.mode === "off") return null;
    const age =
      lastCheckAt === null
        ? Number.POSITIVE_INFINITY
        : now.getTime() - Date.parse(lastCheckAt);
    const today = day(now);
    if (
      schedule.mode === "install" &&
      now.getHours() === schedule.hour &&
      lastAutomatic !== today
    ) {
      if (!(age <= FRESH_MS)) return { kind: "check" };
      return offered ? { kind: "install", day: today } : null;
    }
    return age <= CHECK_EVERY_MS ? null : { kind: "check" };
  },
} as const;
