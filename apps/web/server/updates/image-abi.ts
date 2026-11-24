import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ImageAbi as Abi } from "./update-offer";

/**
 * What the image provides to the releases it runs: its Bun, its supervisor protocol, and native
 * packages in its built-in release (`<built-in>/apps/web/node_modules/<name>`), which a bundle
 * does not carry and links to instead.
 */
export const ImageAbi = {
  /** The ABI for `native` package names, with where each provided one lives. */
  async read(
    builtInRoot: string,
    supervisorProtocol: number,
    native: readonly string[],
  ) {
    const abi: Abi = { bun: Bun.version, supervisorProtocol, native: {} };
    const locations = new Map<string, string>();
    for (const name of native) {
      const folder = path.join(builtInRoot, "apps/web/node_modules", name);
      try {
        const real = await realpath(folder);
        const declared: unknown = JSON.parse(
          await readFile(path.join(real, "package.json"), "utf8"),
        );
        const version =
          typeof declared === "object" &&
          declared !== null &&
          "version" in declared
            ? declared.version
            : null;
        if (typeof version === "string") {
          abi.native[name] = version;
          locations.set(name, real);
        }
      } catch {
        // Not provided: the offer rules say so.
      }
    }
    return { abi, locations };
  },
} as const;
