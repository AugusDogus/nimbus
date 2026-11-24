import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

type Checked = { ok: true; real: string } | { ok: false; message: string };

/** Owners whose folders the supervisor may rely on: root, and its own user. */
const trustedOwner = (uid: number) => uid === 0 || uid === process.getuid?.();

/**
 * Whether a path can only be changed by root or the supervisor's user (see docs/updates.md).
 * It is checked as the kernel resolves it, through the real path: every folder on the way must
 * belong to one of them and be writable by nobody else, unless it is sticky (as /tmp), where
 * others may add entries but not rename or remove one they do not own.
 */
export const TrustedPath = {
  /** Whether everything above `target`'s real path is trusted; `target` itself is not checked. */
  async ancestors(target: string): Promise<Checked> {
    let real: string;
    try {
      real = await realpath(target);
    } catch (error) {
      return {
        ok: false,
        message: `${target} cannot be resolved (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    const parts = real.split(path.sep).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      const folder = path.join(path.sep, ...parts.slice(0, index));
      const stats = await lstat(folder);
      if (!trustedOwner(stats.uid))
        return {
          ok: false,
          message: `${folder}, on the way to ${real}, belongs to user ${stats.uid}, who could replace what is below it`,
        };
      if (stats.mode & 0o022 && !(stats.mode & 0o1000))
        return {
          ok: false,
          message: `${folder}, on the way to ${real}, is writable by others, who could replace what is below it`,
        };
    }
    return { ok: true, real };
  },

  /** Whether folder `target` and everything above it are trusted (see above). */
  async folder(target: string): Promise<Checked> {
    const above = await TrustedPath.ancestors(target);
    if (!above.ok) return above;
    const stats = await lstat(above.real);
    if (!stats.isDirectory())
      return { ok: false, message: `${above.real} is not a folder` };
    if (!trustedOwner(stats.uid))
      return {
        ok: false,
        message: `${above.real} belongs to user ${stats.uid}`,
      };
    if (stats.mode & 0o022)
      return { ok: false, message: `${above.real} is writable by others` };
    return above;
  },
} as const;
