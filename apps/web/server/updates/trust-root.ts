import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { ReleaseSignature, type TrustRoot as Keys } from "./release-signature";

/** Far beyond any list of keys; a bigger file is not one. */
const MAX_KEYS_BYTES = 64 * 1024;

/**
 * The keys this installation trusts (see docs/updates.md): the image's
 * `apps/web/release-keys.json`, never downloaded and never replaced in an image. Tests in a
 * source checkout may pass `testKeysFile` instead (TestSeams). Either is opened once, without
 * following a link or waiting on a pipe, and read through that descriptor once it is known to be
 * a regular file.
 */
export const TrustRoot = {
  async load(
    builtInRoot: string,
    testKeysFile: string | null,
  ): Promise<{ ok: true; value: Keys } | { ok: false; message: string }> {
    const file =
      testKeysFile ?? path.join(builtInRoot, "apps/web/release-keys.json");
    const refuse = (why: string) => ({
      ok: false as const,
      message: `The release keys file ${file} ${why}, so no update can be verified.`,
    });
    let bytes: Uint8Array;
    try {
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const details = await handle.stat();
        if (!details.isFile()) return refuse("is not a regular file");
        if (details.size > MAX_KEYS_BYTES)
          return refuse("is too large for a list of keys");
        bytes = new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    } catch (error) {
      return refuse(
        `could not be read (${error instanceof Error && "code" in error ? String(error.code) : "unknown error"})`,
      );
    }
    const parsed = await ReleaseSignature.trustRoot(bytes);
    return parsed.ok ? parsed : { ok: false, message: parsed.error.message };
  },
} as const;
