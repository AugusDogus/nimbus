import { z } from "zod";

/**
 * Messages between the supervisor (supervisor.ts) and the servers it runs (start.ts, called
 * workers here) over Bun's IPC channel.
 *
 * A worker listens with `reusePort`, so the next one can listen on the same port before this
 * one stops. It listens only once it is ready: database migrated, search index built, health
 * check passing. Told to drain, it closes its listener at once, ends live event streams so their
 * clients reconnect to the next worker, drops what it no longer needs, and keeps serving the
 * responses it has already started, such as a film being streamed, until they end or its
 * deadline passes.
 *
 * While several workers run, the supervisor is the one place that grants path scopes for file
 * changes (see `mutateFiles`), so no two workers change overlapping paths at once, and it
 * passes on the signals that stop transfers to paired devices.
 *
 * The supervisor ships in the image and workers may come from newer releases, so both name the
 * protocol version they speak, and a worker refuses to run under another.
 */
export const PROTOCOL_VERSION = 1;

const scope = z.object({ space: z.string().min(1), path: z.string() });
const scopes = z.tuple([scope], scope);

/** What stops or rechecks transfers to paired devices, passed on to every other worker. */
const transferSignal = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("devices-ended"),
    deviceIds: z.array(z.string()),
  }),
  z.object({ kind: z.literal("library-deleted"), libraryId: z.string() }),
  z.object({ kind: z.literal("library-changed"), libraryId: z.string() }),
]);
export type TransferSignal = z.infer<typeof transferSignal>;

const supervisorMessage = z.discriminatedUnion("kind", [
  /**
   * Stop accepting and drain: finish the responses already started until `deadline` (epoch
   * milliseconds), then exit. A later drain may bring the deadline forward.
   */
  z.object({ kind: z.literal("drain"), deadline: z.number() }),
  /** This worker now takes new connections alone: start the work only one worker does. */
  z.object({ kind: z.literal("active") }),
  /** No other worker runs any more: recover changes a crash may have left unfinished. */
  z.object({ kind: z.literal("alone") }),
  /** The path scopes asked for as `id` are held for this worker until it releases them. */
  z.object({ kind: z.literal("scopes-granted"), id: z.number() }),
  /** Another worker stopped or rechecks transfers. */
  z.object({ kind: z.literal("transfer-signal"), signal: transferSignal }),
]);
export type SupervisorMessage = z.infer<typeof supervisorMessage>;

const workerMessage = z.discriminatedUnion("kind", [
  /** Listening and as able as the worker it replaces. */
  z.object({
    kind: z.literal("ready"),
    build: z.string().nullable(),
    startupMs: z.number(),
  }),
  /** Responses still being sent while draining. */
  z.object({ kind: z.literal("in-flight"), count: z.number().int() }),
  /** Done draining; `forced` when its deadline cut responses off. Exits next. */
  z.object({ kind: z.literal("drained"), forced: z.boolean() }),
  z.object({ kind: z.literal("acquire-scopes"), id: z.number(), scopes }),
  z.object({ kind: z.literal("release-scopes"), id: z.number() }),
  z.object({ kind: z.literal("transfer-signal"), signal: transferSignal }),
]);
export type WorkerMessage = z.infer<typeof workerMessage>;

/** Variables the supervisor sets for every worker it starts. */
export const WorkerEnv = {
  protocol: "NIMBUS_SUPERVISOR_PROTOCOL",
  /** The release's name, as the supervisor's status reports it. */
  release: "NIMBUS_RELEASE",
  /** "1" while other workers still run: work only a lone worker may do waits for `alone`. */
  predecessor: "NIMBUS_PREDECESSOR",
  /** Built clients of earlier releases, joined by ":", whose hashed assets stay servable. */
  previousAssets: "NIMBUS_PREVIOUS_ASSETS",
} as const;

export const Protocol = {
  parseSupervisorMessage(value: unknown): SupervisorMessage | null {
    const parsed = supervisorMessage.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  parseWorkerMessage(value: unknown): WorkerMessage | null {
    const parsed = workerMessage.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
} as const;
