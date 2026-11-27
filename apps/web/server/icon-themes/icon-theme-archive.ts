import { unzipSync } from "fflate";

/**
 * Reads an untrusted VS Code extension (a VSIX, which is a zip) into memory for the icon theme
 * compiler. Nothing from the archive is ever written to disk under its own name: the compiler
 * stores icons under their content hash. Still, an archive with a path that climbs out of
 * `extension/`, an absolute path, or a symbolic link is refused whole, as are archives over the
 * size and file-count caps.
 */
export type IconThemeArchive = ReadonlyMap<string, Uint8Array>;

export type ArchiveLimits = {
  /** The compressed archive. */
  archiveBytes: number;
  /** Every entry the archive lists, kept or not. */
  entries: number;
  /** All kept files, unpacked. */
  unpackedBytes: number;
  /** One kept file, unpacked. */
  fileBytes: number;
};

export const archiveLimits: ArchiveLimits = {
  archiveBytes: 40 * 1024 * 1024,
  entries: 20_000,
  unpackedBytes: 64 * 1024 * 1024,
  fileBytes: 4 * 1024 * 1024,
};

/** What the compiler may read: manifests, icons, and the licence beside the manifest. */
export const keptFile = (name: string) =>
  name.startsWith("extension/") &&
  (/\.(json|svg|png)$/i.test(name) ||
    /^extension\/licen[cs]e(\.(txt|md))?$/i.test(name));

/** An archive path that is not a plain relative path inside the archive. */
export const unsafeArchivePath = (name: string) =>
  name.length === 0 ||
  name.length > 1024 ||
  /[\0\\]/.test(name) ||
  name.startsWith("/") ||
  /^[a-z]:/i.test(name) ||
  name.split("/").some((part) => part === ".." || part === ".");

export type ArchiveResult =
  | { ok: true; files: IconThemeArchive }
  | { ok: false; error: string };

const fail = (error: string): ArchiveResult => ({ ok: false, error });

const unixHost = 3;
const fileTypeMask = 0o170000;
const symlinkType = 0o120000;

/**
 * The central directory's entries, which name every file and carry its Unix mode. fflate does
 * not report modes, so symbolic links are found here, before anything is unpacked.
 */
function centralDirectory(
  bytes: Uint8Array,
  limits: ArchiveLimits,
): { ok: true; names: string[] } | { ok: false; error: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is the last 22 bytes plus a comment of up to 64 KB.
  let end = -1;
  for (
    let offset = bytes.byteLength - 22;
    offset >= Math.max(0, bytes.byteLength - 22 - 0xffff);
    offset--
  )
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  if (end === -1)
    return { ok: false, error: "The download is not a zip archive." };
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff || size === 0xffffffff)
    return {
      ok: false,
      error: "The extension uses a ZIP64 archive, which Nimbus does not read.",
    };
  if (count > limits.entries)
    return {
      ok: false,
      error: `The extension contains more than ${limits.entries} files.`,
    };
  if (offset + size > end)
    return { ok: false, error: "The extension archive is damaged." };
  const names: string[] = [];
  const decoder = new TextDecoder();
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      return { ok: false, error: "The extension archive is damaged." };
    const host = view.getUint8(offset + 5);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (unsafeArchivePath(name.replace(/\/$/, "")))
      return {
        ok: false,
        error: `The extension contains a file with an unsafe path (${JSON.stringify(name.slice(0, 120))}).`,
      };
    if (host === unixHost && (mode & fileTypeMask) === symlinkType)
      return {
        ok: false,
        error: `The extension contains a symbolic link (${name.slice(0, 120)}), which Nimbus does not accept.`,
      };
    names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { ok: true, names };
}

function read(
  bytes: Uint8Array,
  limits: ArchiveLimits = archiveLimits,
): ArchiveResult {
  if (bytes.byteLength > limits.archiveBytes)
    return fail(
      `The extension is larger than ${Math.round(limits.archiveBytes / 1024 / 1024)} MB.`,
    );
  const listed = centralDirectory(bytes, limits);
  if (!listed.ok) return listed;
  let unpacked = 0;
  // Set inside fflate's filter; a holder keeps the check after it honest for the type checker.
  const state: { refusal: string | null } = { refusal: null };
  try {
    const files = unzipSync(bytes, {
      filter(entry) {
        if (state.refusal !== null || !keptFile(entry.name)) return false;
        // A stored entry copies `size` bytes; a deflated one inflates into `originalSize`.
        if (entry.compression === 0 && entry.size !== entry.originalSize) {
          state.refusal = "The extension archive is damaged.";
          return false;
        }
        const size = Math.max(entry.size, entry.originalSize);
        unpacked += size;
        if (size > limits.fileBytes)
          state.refusal = `${entry.name.slice("extension/".length)} is larger than ${Math.round(limits.fileBytes / 1024 / 1024)} MB.`;
        else if (unpacked > limits.unpackedBytes)
          state.refusal = `The extension's icons and manifests unpack to more than ${Math.round(limits.unpackedBytes / 1024 / 1024)} MB.`;
        return state.refusal === null;
      },
    });
    if (state.refusal !== null) return fail(state.refusal);
    return { ok: true, files: new Map(Object.entries(files)) };
  } catch {
    return fail(
      "The extension archive is damaged or uses an unsupported compression.",
    );
  }
}

export const IconThemeArchive = { read } as const;
