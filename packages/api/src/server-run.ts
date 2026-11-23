import { randomUUID } from "node:crypto";

/**
 * One run of the server: from the moment it started serving until it stops for good. Anything
 * that a restart must end, such as transfer receipts and MCP upload links, is bound to it.
 *
 * A server started on its own is one run per process. Under the supervisor
 * (apps/web/server/supervisor), which replaces the server process during an update without
 * stopping, a run lasts as long as the supervisor: from the container's start to its stop. The
 * supervisor passes its run to every server it starts, so an update keeps receipts and links
 * working, while a container restart, a host reboot or a remounted array still ends them.
 */
export type ServerRun = {
  /** Distinct for every run. */
  id: string;
  /** When the run started, in milliseconds since the epoch. */
  startedAt: number;
};

const env = {
  id: "NIMBUS_RUN_ID",
  startedAt: "NIMBUS_RUN_STARTED_AT",
} as const;

export type ServerRunError = { kind: "invalid-run"; message: string };

/**
 * The run named by `NIMBUS_RUN_ID` and `NIMBUS_RUN_STARTED_AT`, a new run when neither is set,
 * or why the pair cannot be used.
 */
function fromEnvironment(
  variables: Record<string, string | undefined>,
  now = Date.now(),
): { ok: true; run: ServerRun } | { ok: false; error: ServerRunError } {
  const id = variables[env.id];
  const startedAt = variables[env.startedAt];
  if (id === undefined && startedAt === undefined)
    return { ok: true, run: { id: randomUUID(), startedAt: now } };
  const started = Number(startedAt);
  if (
    id === undefined ||
    !/^[\w-]{16,64}$/.test(id) ||
    startedAt === undefined ||
    !Number.isSafeInteger(started) ||
    started <= 0 ||
    started > now
  )
    return {
      ok: false,
      error: {
        kind: "invalid-run",
        message: `${env.id} and ${env.startedAt} must be set together, as the supervisor sets them: an id of 16 to 64 letters, digits, dashes or underscores, and a start time in milliseconds that is not in the future. Got ${env.id}=${id ?? "(unset)"} and ${env.startedAt}=${startedAt ?? "(unset)"}. Unset both to run on its own.`,
      },
    };
  return { ok: true, run: { id, startedAt: started } };
}

/**
 * This process's run, read once when the module loads, which the server does at startup: a run
 * read only when first needed would start after links and receipts issued before then.
 */
const loaded = fromEnvironment(process.env);

export const ServerRun = {
  env,
  fromEnvironment,
  /**
   * This process's run. Throws on an invalid pair: only the supervisor sets it, so that is a bug
   * to stop on, not a condition to serve through.
   */
  current(): ServerRun {
    if (!loaded.ok) throw new Error(loaded.error.message);
    return loaded.run;
  },
} as const;
