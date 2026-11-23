import type { SupervisorSettings } from "./supervisor";

/** Where the control socket lives unless NIMBUS_SUPERVISOR_SOCKET says otherwise. */
export const defaultSocketPath = "/tmp/nimbus-supervisor/control.sock";

export type ParsedSettings = SupervisorSettings & {
  /** Directory of further releases a handover may name, or null when only the built-in one. */
  releasesDir: string | null;
  socketPath: string;
};

type Variables = Record<string, string | undefined>;

/** A number from `name`: its default when unset, an error message when out of range. */
function number(
  env: Variables,
  name: string,
  fallback: number,
  { min, max, integer }: { min: number; max: number; integer: boolean },
): { ok: true; value: number } | { ok: false; message: string } {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "")
    return { ok: true, value: fallback };
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    return {
      ok: false,
      message: `${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}; got ${raw}.`,
    };
  return { ok: true, value };
}

/**
 * The supervisor's settings from the environment, or every problem with them:
 *
 * - NIMBUS_DRAIN_HOURS (6): how long a replaced server keeps sending responses it had started.
 *   Long enough for a film begun before an update to play to its end; a paused player's
 *   connection closes after 255 seconds anyway, so a drainer rarely lives this long.
 * - NIMBUS_MAX_DRAINING (2): replaced servers kept draining at once.
 * - NIMBUS_READY_TIMEOUT_SECONDS (300): how long a new server may take to get ready, search index
 *   included, before the update is abandoned.
 * - NIMBUS_STOP_SECONDS (30): how long servers drain when the container stops. Keep it below
 *   the container's stop timeout.
 * - NIMBUS_RELEASES_DIR: a directory of further releases a handover may name.
 * - NIMBUS_SUPERVISOR_SOCKET: the control socket's path.
 */
export function parseSettings(
  env: Variables,
): { ok: true; value: ParsedSettings } | { ok: false; messages: string[] } {
  const drainHours = number(env, "NIMBUS_DRAIN_HOURS", 6, {
    min: 0.01,
    max: 48,
    integer: false,
  });
  const maxDraining = number(env, "NIMBUS_MAX_DRAINING", 2, {
    min: 1,
    max: 8,
    integer: true,
  });
  const ready = number(env, "NIMBUS_READY_TIMEOUT_SECONDS", 300, {
    min: 5,
    max: 3600,
    integer: false,
  });
  const stop = number(env, "NIMBUS_STOP_SECONDS", 30, {
    min: 1,
    max: 3600,
    integer: false,
  });
  const messages = [drainHours, maxDraining, ready, stop].flatMap((parsed) =>
    parsed.ok ? [] : [parsed.message],
  );
  const socketPath = env.NIMBUS_SUPERVISOR_SOCKET || defaultSocketPath;
  if (!socketPath.startsWith("/"))
    messages.push(
      `NIMBUS_SUPERVISOR_SOCKET must be an absolute path; got ${socketPath}.`,
    );
  if (
    !drainHours.ok ||
    !maxDraining.ok ||
    !ready.ok ||
    !stop.ok ||
    messages.length
  )
    return { ok: false, messages };
  return {
    ok: true,
    value: {
      drainMs: Math.round(drainHours.value * 60 * 60 * 1000),
      maxDraining: maxDraining.value,
      readyTimeoutMs: Math.round(ready.value * 1000),
      stopMs: Math.round(stop.value * 1000),
      restartMs: { initial: 1_000, max: 30_000 },
      releasesDir: env.NIMBUS_RELEASES_DIR || null,
      socketPath,
    },
  };
}
