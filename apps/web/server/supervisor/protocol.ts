import { z } from "zod";
import {
  requestId,
  updateAudit,
  updatePanel,
  updateRequest,
} from "./update-protocol";

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
 * protocol version they speak: a worker refuses to run under another, and the supervisor starts
 * no release whose `apps/web/release.json` names another (see ReleaseDirectory). Version 2
 * replaced `alone` and `fence-done` with `recover`, `fence-release` and `recovered`; version 3
 * added the update requests of the administration page (see update-protocol.ts).
 */
export const PROTOCOL_VERSION = 3;

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
  /**
   * Server process `owner` exited: settle the changes it left unfinished (see
   * PendingChanges.recoverOwned). `fence` is what it held, by grant, each kept held for it until
   * this worker answers `fence-release` for it; the recovery lasts until it answers
   * `recovered`, and goes to the next active worker if this one exits first.
   */
  z.object({
    kind: z.literal("recover"),
    id: z.number(),
    owner: z.string(),
    fence: z.array(z.object({ grant: z.number(), scopes: z.array(scope) })),
  }),
  /** The path scopes asked for as `id` are held for this worker until it releases them. */
  z.object({ kind: z.literal("scopes-granted"), id: z.number() }),
  /** Another worker stopped or rechecks transfers. */
  z.object({ kind: z.literal("transfer-signal"), signal: transferSignal }),
  /** The answer to update request `id`: the update page's state, or why not. */
  z.object({
    kind: z.literal("update-answer"),
    id: requestId,
    answer: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), panel: updatePanel }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  }),
  /** How the install or rollback of request `id` goes: a HandoverStream event, `done` last. */
  z.object({
    kind: z.literal("update-event"),
    id: requestId,
    event: z.unknown(),
  }),
  /** An automatic install or rollback ended: the active worker records it in the audit log. */
  z.object({ kind: z.literal("update-audit"), entry: updateAudit }),
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
  /**
   * Its pending migrations are not safe beside an older server (see MigrationGate), so it did
   * not apply them and exits: the supervisor stops every server and starts it alone instead.
   */
  z.object({ kind: z.literal("needs-full-restart"), reason: z.string() }),
  /** The changes inside grant `grant` of recovery `id`'s fence are settled: it may go. */
  z.object({
    kind: z.literal("fence-release"),
    id: z.number(),
    grant: z.number(),
  }),
  /** Every change recovery `id`'s owner left is settled. */
  z.object({ kind: z.literal("recovered"), id: z.number() }),
  z.object({ kind: z.literal("transfer-signal"), signal: transferSignal }),
  /** One of the closed set of update requests (see update-protocol.ts), answered by `id`. */
  z.strictObject({
    kind: z.literal("update-request"),
    id: requestId,
    request: updateRequest,
  }),
]);
export type WorkerMessage = z.infer<typeof workerMessage>;

/** The exit code of a worker that needs a full restart, in case its message was not delivered. */
export const NEEDS_FULL_RESTART_EXIT = 75;

/** Variables the supervisor sets for every worker it starts. */
export const WorkerEnv = {
  protocol: "NIMBUS_SUPERVISOR_PROTOCOL",
  /** The release's name, as the supervisor's status reports it. */
  release: "NIMBUS_RELEASE",
  /** "1" while other workers still run: startup then recovers nothing; see `recover`. */
  predecessor: "NIMBUS_PREDECESSOR",
  /** Built clients of earlier releases, joined by ":", whose hashed assets stay servable. */
  previousAssets: "NIMBUS_PREVIOUS_ASSETS",
  /** The supervisor's pid: a server whose parent is another has outlived it, and stops. */
  supervisorPid: "NIMBUS_SUPERVISOR_PID",
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
