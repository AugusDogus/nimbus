import { z } from "zod";

/**
 * What a server may ask its supervisor about updates, for the administration page (see
 * docs/updates.md, Updates from Settings). A server runs as PUID and is assumed compromisable, and
 * the supervisor is root, so this is a closed set with no free-form argument: no release, path,
 * URL or text can be named through it.
 *
 * - `status`: what the update page shows.
 * - `check`: ask the configured update source for its newest signed manifest.
 * - `install`: install the release the last check offered, which is newer than anything run here.
 * - `rollback`: hand back to the recorded previous release, verified.
 * - `schedule`: one of three modes and an hour.
 *
 * The supervisor validates every field (strict objects: an unknown field fails), answers each
 * request by its id, and rate-limits each kind (UpdateRequestLimits).
 */
export const updateRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("status") }),
  z.strictObject({ kind: z.literal("check") }),
  z.strictObject({ kind: z.literal("install") }),
  z.strictObject({ kind: z.literal("rollback") }),
  z.strictObject({
    kind: z.literal("schedule"),
    mode: z.enum(["off", "notify", "install"]),
    hour: z.number().int().min(0).max(23),
  }),
]);
export type UpdateRequest = z.infer<typeof updateRequest>;

/** A request id: a positive integer the worker chose, echoed in its answer. */
export const requestId = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31);

const build = z.object({
  sequence: z.number(),
  commit: z.string(),
  channel: z.string(),
  publishedAt: z.string(),
  repository: z.string(),
});

/** What an operation is doing: where an install or rollback is, for its progress. */
export const updateOperation = z.object({
  kind: z.enum(["install", "rollback"]),
  /** Who started it: an administrator, or the schedule at its quiet hour. */
  by: z.enum(["administrator", "schedule"]),
  startedAt: z.string(),
  /** `preparing`: downloading, verifying and publishing; then the supervisor's own phase. */
  stage: z.string(),
  seconds: z.number(),
  starting: z.object({ release: z.string(), pid: z.number() }).nullable(),
  readyTimeoutSeconds: z.number(),
});
export type UpdateOperation = z.infer<typeof updateOperation>;

/** How the last install or rollback ended. */
export const updateOutcome = z.object({
  kind: z.enum(["install", "rollback"]),
  by: z.enum(["administrator", "schedule"]),
  ok: z.boolean(),
  /** What runs after it. */
  release: z.string(),
  message: z.string(),
  at: z.string(),
});
export type UpdateOutcome = z.infer<typeof updateOutcome>;

/** What the update page shows: the updater's status, with what is under way and how it ended. */
export const updatePanel = z.object({
  running: z.object({
    name: z.string(),
    sequence: z.number().nullable(),
    commit: z.string().nullable(),
  }),
  channel: z.string().nullable(),
  source: z.union([
    z.object({ kind: z.literal("off"), reason: z.string() }),
    z.object({
      kind: z.literal("url"),
      url: z.string(),
      origin: z.string(),
    }),
  ]),
  unavailable: z.string().nullable(),
  lastCheck: z.object({ at: z.string(), outcome: z.string() }).nullable(),
  available: z
    .object({
      kind: z.enum(["offer", "needs-newer-image"]),
      build,
      notes: z.array(z.object({ commit: z.string(), subject: z.string() })),
      message: z.string(),
    })
    .nullable(),
  previous: z.string().nullable(),
  schedule: z.object({
    mode: z.enum(["off", "notify", "install"]),
    hour: z.number(),
  }),
  /** The time zone the schedule's hour is in: the server's. */
  timeZone: z.string(),
  operation: updateOperation.nullable(),
  lastOutcome: updateOutcome.nullable(),
});
export type UpdatePanel = z.infer<typeof updatePanel>;

/** An automatic install or rollback's outcome, for the active server to record in the audit log. */
export const updateAudit = z.object({
  action: z.enum([
    "update.installed",
    "update.install_failed",
    "update.rolled_back",
    "update.rollback_failed",
  ]),
  release: z.string(),
  message: z.string(),
});
export type UpdateAudit = z.infer<typeof updateAudit>;

/** At most this many requests of each kind in each window, from all servers together. */
export const UpdateRequestLimits: Record<
  UpdateRequest["kind"],
  { count: number; windowMs: number }
> = {
  status: { count: 60, windowMs: 10_000 },
  check: { count: 3, windowMs: 60_000 },
  install: { count: 2, windowMs: 60_000 },
  rollback: { count: 2, windowMs: 60_000 },
  schedule: { count: 10, windowMs: 60_000 },
};
