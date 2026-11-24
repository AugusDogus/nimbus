import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Native binaries: compiled for one platform and libc, so they belong to the image, which
 * provides them to every release; a bundle carrying one would run only where it was built.
 * Known by their headers (ELF, Mach-O, PE), whatever they are named, and by the names native
 * modules and libraries have.
 */
const nativeName = /\.(node|dylib|dll)$|\.so(\.\d+)*$/;

/** Mach-O magics, 32 and 64 bit, in either byte order. */
const machO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);

/** Whether `head`, a file's first bytes, starts an executable or library of some platform. */
function nativeHeader(head: Uint8Array) {
  if (head.length < 4) return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const magic = view.getUint32(0);
  if (magic === 0x7f454c46) return true; // "\x7fELF"
  if (machO.has(magic)) return true;
  // A universal Mach-O counts its architectures next; a Java class has its version there.
  if (magic === 0xcafebabe)
    return head.length >= 8 && view.getUint32(4) > 0 && view.getUint32(4) < 45;
  // PE: "MZ", and at the offset stored at 0x3c, "PE\0\0".
  if (head[0] === 0x4d && head[1] === 0x5a && head.length >= 0x40) {
    const offset = view.getUint32(0x3c, true);
    return offset + 4 <= head.length && view.getUint32(offset) === 0x50450000;
  }
  return false;
}

/** Enough of a file to find a PE header at a usual offset. */
const HEAD_BYTES = 1024;

async function head(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export const NativeArtifacts = {
  /** Native binaries under `root`, as paths relative to it; links are not followed. */
  async find(root: string) {
    const found: string[] = [];
    for (const entry of await readdir(root, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (nativeName.test(entry.name) || nativeHeader(await head(file)))
        found.push(path.relative(root, file));
    }
    return found.sort();
  },
} as const;
