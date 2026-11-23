import { lstat, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { isFsError } from "@nimbus/api/safe-path";

export type ControlSocketError = { kind: "control-socket"; message: string };

/** Whether something accepts connections on the socket at `socket`. */
function answers(socket: string) {
  return new Promise<boolean>((resolve) => {
    const probe = net.connect(socket);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
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
  if (await answers(socket))
    return fail(
      `Another supervisor answers on ${socket}, so this one did not start. Stop it first, or set NIMBUS_SUPERVISOR_SOCKET elsewhere. Nothing was changed.`,
    );
  await rm(socket);
  return { ok: true, value: undefined };
}

export const ControlSocket = { prepare } as const;
