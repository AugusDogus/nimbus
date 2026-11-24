import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { ReleaseSignature, type TrustRoot as Keys } from "./release-signature";
import { TrustedPath } from "./trusted-path";

/** Far beyond any list of keys; a bigger file is not one. */
const MAX_KEYS_BYTES = 64 * 1024;

/**
 * The keys this installation trusts (see docs/updates.md): the image's
 * `apps/web/release-keys.json`, never downloaded. NIMBUS_RELEASE_KEYS_FILE replaces it, for a
 * fork or mirror that signs with its own key. That file is opened once, without following a
 * link, and what is checked is what is read, through that one descriptor: a regular file
 * belonging to root or the supervisor's user and writable by nobody else, on a path no one else
 * can change (TrustedPath). Otherwise no key is trusted: a server must not choose what its
 * supervisor trusts.
 */
export const TrustRoot = {
  async load(
    builtInRoot: string,
    configured = process.env.NIMBUS_RELEASE_KEYS_FILE,
  ): Promise<{ ok: true; value: Keys } | { ok: false; message: string }> {
    const file =
      configured || path.join(builtInRoot, "apps/web/release-keys.json");
    const refuse = (why: string) => ({
      ok: false as const,
      message: `NIMBUS_RELEASE_KEYS_FILE (${file}) ${why}, so no update is trusted. Point it at a file only root or the supervisor's user can change.`,
    });
    let bytes: Uint8Array;
    try {
      // The path checked is the path opened: the real one, with every folder on it trusted.
      let opened = file;
      if (configured) {
        const above = await TrustedPath.ancestors(file);
        if (!above.ok)
          return refuse(`is not on a trusted path: ${above.message}`);
        if (above.real !== path.resolve(file))
          return refuse(`leads elsewhere (${above.real}) through a link`);
        opened = above.real;
      }
      const handle = await open(
        opened,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const details = await handle.stat();
        if (configured) {
          if (!details.isFile()) return refuse("is not a regular file");
          if (!(details.uid === 0 || details.uid === process.getuid?.()))
            return refuse(`belongs to user ${details.uid}`);
          if (details.mode & 0o022) return refuse("is writable by others");
        }
        if (details.size > MAX_KEYS_BYTES)
          return refuse("is too large for a list of keys");
        bytes = new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    } catch (error) {
      return {
        ok: false,
        message: `Nimbus could not read the release keys it trusts from ${file} (${error instanceof Error ? error.message : String(error)}), so no update can be verified.`,
      };
    }
    const parsed = await ReleaseSignature.trustRoot(bytes);
    return parsed.ok ? parsed : { ok: false, message: parsed.error.message };
  },
} as const;
