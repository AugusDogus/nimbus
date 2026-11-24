import { stat } from "node:fs/promises";
import path from "node:path";
import { ReleaseSignature, type TrustRoot as Keys } from "./release-signature";

/**
 * The keys this installation trusts (see docs/updates.md): the image's
 * `apps/web/release-keys.json`, never downloaded. NIMBUS_RELEASE_KEYS_FILE replaces it, for a
 * fork or mirror that signs with its own key; that file must belong to root or the supervisor's
 * user and be writable by nobody else, or a server could choose what its supervisor trusts.
 */
export const TrustRoot = {
  async load(
    builtInRoot: string,
    configured = process.env.NIMBUS_RELEASE_KEYS_FILE,
  ): Promise<{ ok: true; value: Keys } | { ok: false; message: string }> {
    const file =
      configured || path.join(builtInRoot, "apps/web/release-keys.json");
    let bytes: Uint8Array;
    try {
      if (configured) {
        const details = await stat(file);
        const owner = details.uid === 0 || details.uid === process.getuid?.();
        if (!owner || details.mode & 0o022)
          return {
            ok: false,
            message: `NIMBUS_RELEASE_KEYS_FILE (${file}) must belong to root or the supervisor's user and be writable by nobody else, so no update was trusted. Fix its owner and mode.`,
          };
      }
      bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
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
