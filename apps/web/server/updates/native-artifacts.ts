import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Native binaries: compiled for one platform and libc, so they belong to the image, which
 * provides them to every release; a bundle carrying one would run only where it was built.
 */
const native = /\.(node|dylib|dll)$|\.so(\.\d+)*$/;

export const NativeArtifacts = {
  /** Native binaries under `root`, as paths relative to it; links are not followed. */
  async find(root: string) {
    const found: string[] = [];
    for (const entry of await readdir(root, {
      recursive: true,
      withFileTypes: true,
    }))
      if (entry.isFile() && native.test(entry.name))
        found.push(
          path.relative(root, path.join(entry.parentPath, entry.name)),
        );
    return found.sort();
  },
} as const;
