import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol";
import type { Release } from "./supervisor";

/**
 * A release directory a handover names, checked before anything of it runs: it must hold a
 * server, and its `apps/web/release.json` must say it speaks this supervisor's protocol. A
 * release that speaks another, or does not say, could be started beside a live server and then
 * ignore what that protocol asks of it, such as settling a dead server's changes.
 */
const metadata = z.object({ supervisorProtocol: z.number().int() });

function readMetadata(root: string): unknown {
  try {
    return JSON.parse(
      readFileSync(path.join(root, "apps/web/release.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

export const ReleaseDirectory = {
  /** Whether `root` holds a release this supervisor may start, or why not. */
  check(root: string): { ok: true } | { ok: false; reason: string } {
    if (!existsSync(path.join(root, "apps/web/server/start.ts")))
      return { ok: false, reason: `${root} holds no Nimbus server` };
    const declared = metadata.safeParse(readMetadata(root));
    if (!declared.success)
      return {
        ok: false,
        reason: `${root} does not say which supervisor protocol it speaks (apps/web/release.json), so it may be older than this supervisor, which speaks protocol ${PROTOCOL_VERSION}`,
      };
    if (declared.data.supervisorProtocol !== PROTOCOL_VERSION)
      return {
        ok: false,
        reason: `${root} speaks supervisor protocol ${declared.data.supervisorProtocol}, but this supervisor speaks protocol ${PROTOCOL_VERSION}; update the container image to run it`,
      };
    return { ok: true };
  },

  /** Release `name` in `releasesDir`, or why it may not start. */
  resolve(
    releasesDir: string,
    name: string,
  ): { ok: true; release: Release } | { ok: false; reason: string } {
    if (!/^[\w][\w.-]{0,63}$/.test(name))
      return {
        ok: false,
        reason: `release names are letters, digits, dots, dashes and underscores; got ${name}`,
      };
    const root = path.join(releasesDir, name);
    const checked = ReleaseDirectory.check(root);
    return checked.ok ? { ok: true, release: { name, root } } : checked;
  },
} as const;
