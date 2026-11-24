import * as z from "zod/mini";

/**
 * What the Updates section reads from `/api/admin/updates`: the supervisor's update panel
 * (server/supervisor/update-protocol.ts) and the handover events an install or rollback streams
 * (server/supervisor/handover-stream.ts), parsed here as the page needs them.
 */
const build = z.object({
  sequence: z.number(),
  commit: z.string(),
  channel: z.string(),
  publishedAt: z.string(),
});

export const updatePanel = z.object({
  running: z.object({
    name: z.string(),
    sequence: z.nullable(z.number()),
    commit: z.nullable(z.string()),
  }),
  channel: z.nullable(z.string()),
  source: z.union([
    z.object({ kind: z.literal("off"), reason: z.string() }),
    z.object({ kind: z.literal("url"), url: z.string(), origin: z.string() }),
  ]),
  unavailable: z.nullable(z.string()),
  lastCheck: z.nullable(z.object({ at: z.string(), outcome: z.string() })),
  available: z.nullable(
    z.object({
      kind: z.enum(["offer", "needs-newer-image"]),
      build,
      notes: z.array(z.object({ commit: z.string(), subject: z.string() })),
      message: z.string(),
    }),
  ),
  previous: z.nullable(z.string()),
  schedule: z.object({
    mode: z.enum(["off", "notify", "install"]),
    hour: z.number(),
  }),
  timeZone: z.string(),
  operation: z.nullable(
    z.object({
      kind: z.enum(["install", "rollback"]),
      by: z.enum(["administrator", "schedule"]),
      startedAt: z.string(),
      stage: z.string(),
      seconds: z.number(),
      starting: z.nullable(z.object({ release: z.string(), pid: z.number() })),
      readyTimeoutSeconds: z.number(),
    }),
  ),
  lastOutcome: z.nullable(
    z.object({
      kind: z.enum(["install", "rollback"]),
      by: z.enum(["administrator", "schedule"]),
      ok: z.boolean(),
      release: z.string(),
      message: z.string(),
      at: z.string(),
    }),
  ),
});
export type UpdatePanel = z.infer<typeof updatePanel>;

export const panelAnswer = z.object({ panel: updatePanel });
export const errorAnswer = z.object({ error: z.string() });

/** One line of an install's or rollback's stream. */
export const updateEvent = z.union([
  z.object({
    kind: z.literal("started"),
    readyTimeoutSeconds: z.number(),
  }),
  z.object({
    kind: z.literal("progress"),
    seconds: z.number(),
    phase: z.string(),
    starting: z.nullable(z.object({ release: z.string(), pid: z.number() })),
  }),
  z.object({
    kind: z.literal("done"),
    ok: z.boolean(),
    report: z.optional(z.object({ to: z.string() })),
    error: z.optional(z.object({ kind: z.string(), message: z.string() })),
  }),
]);
export type UpdateEvent = z.infer<typeof updateEvent>;
