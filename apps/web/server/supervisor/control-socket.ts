import { lstat, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { isFsError } from "@nimbus/api/safe-path";

export type ControlSocketError = { kind: "control-socket"; message: string };

/**
 * What connecting to `socket` says about it: something answers, nothing listens any more
 * (ECONNREFUSED), it is already gone (ENOENT), or it could not tell, such as EACCES.
 */
function probe(socket: string) {
  return new Promise<
    | { kind: "live" }
    | { kind: "dead" }
    | { kind: "gone" }
    | { kind: "unknown"; code: string }
  >((resolve) => {
    const connection = net.connect(socket);
    connection.once("connect", () => {
      connection.destroy();
      resolve({ kind: "live" });
    });
    connection.once("error", (error: Error & { code?: string }) => {
      if (error.code === "ECONNREFUSED") resolve({ kind: "dead" });
      else if (error.code === "ENOENT") resolve({ kind: "gone" });
      else resolve({ kind: "unknown", code: error.code ?? error.message });
    });
  });
}

/**
 * Make the control socket's place ready: a directory only this user may enter (and root), and
 * no live socket in the way. Only a socket that nothing answers on any more, as a supervisor
 * killed outright leaves, is removed; anything else at the path, such as a file the setting
 * names by mistake, or another supervisor's live socket, is refused and left as it is. Run it
 * while holding the installation lock.
 */
async function prepare(
  socket: string,
): Promise<
  { ok: true; value: undefined } | { ok: false; error: ControlSocketError }
> {
  const fail = (message: string) => ({
    ok: false as const,
    error: { kind: "control-socket" as const, message },
  });
  const directory = path.dirname(socket);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    return fail(
      `${directory} must be a directory owned by this user and closed to others (mode 700), so only this user and root reach the supervisor's control socket. Remove it or set NIMBUS_SUPERVISOR_SOCKET elsewhere. Nothing was changed.`,
    );
  let existing;
  try {
    existing = await lstat(socket);
  } catch (error) {
    if (isFsError(error, "ENOENT")) return { ok: true, value: undefined };
    throw error;
  }
  if (!existing.isSocket())
    return fail(
      `${socket} exists and is not a socket, so the supervisor did not replace it. Set NIMBUS_SUPERVISOR_SOCKET to a path of its own. Nothing was changed.`,
    );
  const found = await probe(socket);
  switch (found.kind) {
    case "live":
      return fail(
        `Another supervisor answers on ${socket}, so this one did not start. Stop it first, or set NIMBUS_SUPERVISOR_SOCKET elsewhere. Nothing was changed.`,
      );
    case "unknown":
      return fail(
        `The supervisor could not tell whether the socket at ${socket} is still in use (${found.code}), so it left it and did not start. Check who owns it, remove it if nothing uses it, or set NIMBUS_SUPERVISOR_SOCKET elsewhere. Nothing was changed.`,
      );
    case "gone":
      return { ok: true, value: undefined };
    case "dead":
      // Only a socket nothing listens on any more: a supervisor killed outright leaves one.
      await rm(socket, { force: true });
      return { ok: true, value: undefined };
  }
}

export const ControlSocket = { prepare } as const;
