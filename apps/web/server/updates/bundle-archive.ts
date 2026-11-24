import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/**
 * A release bundle's archive: a gzip-compressed tar (ustar, with PAX records for long names)
 * of regular files, directories and relative symbolic links, nothing else.
 *
 * Unpacking happens only after the archive's digest matched its signed manifest, so its content
 * is trusted; it is still checked as if it were not. An entry may not be absolute, contain `..`,
 * be written through a symbolic link, or be a link that leads outside the release; any other
 * kind of entry (hard links, devices, FIFOs) is refused; sizes and counts are capped.
 */
export type ArchiveError = { kind: "invalid-archive"; message: string };

const BLOCK = 512;
/** Well beyond any release: 2 GiB unpacked, 200,000 entries. */
const MAX_TOTAL_BYTES = 2 * 1024 ** 3;
const MAX_ENTRIES = 200_000;

const encoder = new TextEncoder();

function octal(value: number, width: number) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** One 512-byte ustar header. Names that do not fit go in a PAX record before it. */
function header(
  name: string,
  type: "0" | "2" | "5" | "x",
  size: number,
  mode: number,
  linkname = "",
) {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, offset: number, width: number) =>
    block.set(encoder.encode(text).subarray(0, width), offset);
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function padding(size: number) {
  return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
}

/** A PAX extended header record: `<length> <key>=<value>\n`, its length counting itself. */
function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).byteLength;
  let length = bodyLength;
  while (length !== bodyLength + String(length).length)
    length = bodyLength + String(length).length;
  return `${length}${body}`;
}

function* entryBlocks(
  name: string,
  type: "0" | "2" | "5",
  size: number,
  mode: number,
  linkname = "",
) {
  const long =
    encoder.encode(name).byteLength > 100 ||
    encoder.encode(linkname).byteLength > 100;
  if (long) {
    const pax = encoder.encode(
      paxRecord("path", name) +
        (linkname ? paxRecord("linkpath", linkname) : ""),
    );
    yield header("PaxHeader", "x", pax.byteLength, 0o644);
    yield pax;
    yield padding(pax.byteLength);
  }
  yield header(
    long ? name.slice(-99) : name,
    type,
    size,
    mode,
    long ? "" : linkname,
  );
}

/** Whether `relative` is a plain path inside the release: no root, no `..`, no empty part. */
function plainPath(relative: string) {
  if (!relative || relative.includes("\0") || relative.startsWith("/"))
    return false;
  const parts = relative.replace(/\/$/, "").split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/** Whether link `relative` with target `target` stays inside the release. */
function linkInside(relative: string, target: string) {
  if (!target || target.includes("\0") || target.startsWith("/")) return false;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relative), target),
  );
  return resolved !== ".." && !resolved.startsWith("../");
}

const fail = (message: string): { ok: false; error: ArchiveError } => ({
  ok: false,
  error: { kind: "invalid-archive", message },
});

export const BundleArchive = {
  /**
   * Write the tree at `root` as a gzip-compressed tar to `output`, entries sorted by path so the
   * same tree always gives the same bytes. Returns its size and SHA-256.
   */
  async write(root: string, output: string) {
    const entries: { name: string; absolute: string }[] = [];
    const walk = async (relative: string) => {
      const listed = await readdir(path.join(root, relative), {
        withFileTypes: true,
      });
      for (const entry of listed.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        entries.push({ name, absolute: path.join(root, name) });
        if (entry.isDirectory()) await walk(name);
      }
    };
    await walk("");
    const gzip = new CompressionStream("gzip");
    const writer = gzip.writable.getWriter();
    const written = (async () => {
      const hash = createHash("sha256");
      let size = 0;
      const file = Bun.file(output).writer();
      for await (const chunk of gzip.readable) {
        hash.update(chunk);
        size += chunk.byteLength;
        // Buffered by the writer; a full buffer is flushed before the next write.
        await file.write(chunk);
      }
      await file.end();
      return { size, sha256: hash.digest("hex") };
    })();
    for (const entry of entries) {
      const stats = await lstat(entry.absolute);
      const linked = stats.isSymbolicLink()
        ? await readlink(entry.absolute)
        : "";
      if (stats.isSymbolicLink() && !linkInside(entry.name, linked))
        throw new Error(
          `The release tree's link ${entry.name} leads outside it (to ${linked}), so no installation would accept the bundle. Remove the link from the tree.`,
        );
      const blocks = stats.isSymbolicLink()
        ? entryBlocks(entry.name, "2", 0, 0o777, await readlink(entry.absolute))
        : stats.isDirectory()
          ? entryBlocks(`${entry.name}/`, "5", 0, 0o755)
          : stats.isFile()
            ? entryBlocks(
                entry.name,
                "0",
                stats.size,
                stats.mode & 0o111 ? 0o755 : 0o644,
              )
            : null;
      if (!blocks)
        throw new Error(
          `The release tree holds ${entry.name}, which is neither a file, a folder nor a symbolic link; a bundle cannot carry it.`,
        );
      for (const block of blocks) await writer.write(block);
      if (stats.isFile() && !stats.isSymbolicLink()) {
        const content = new Uint8Array(
          await Bun.file(entry.absolute).arrayBuffer(),
        );
        await writer.write(content);
        await writer.write(padding(content.byteLength));
      }
    }
    await writer.write(new Uint8Array(BLOCK * 2));
    await writer.close();
    return written;
  },

  /**
   * Unpack the gzip-compressed tar `source` into the empty directory `into`, refusing anything a
   * release does not hold (see above). Leaves partial content on failure: the caller removes
   * `into`.
   */
  async unpack(
    source: ReadableStream<Uint8Array<ArrayBuffer>>,
    into: string,
  ): Promise<
    { ok: true; entries: number } | { ok: false; error: ArchiveError }
  > {
    const reader = source
      .pipeThrough(new DecompressionStream("gzip"))
      .getReader();
    /** Decompressed bytes not taken yet, oldest first; the first may be partly taken. */
    const queue: Uint8Array[] = [];
    let queued = 0;
    let done = false;
    /** Exactly `length` more bytes of the tar, or null at its end. */
    const take = async (length: number) => {
      while (queued < length && !done) {
        const next = await reader.read();
        if (next.done) done = true;
        else {
          queue.push(next.value);
          queued += next.value.byteLength;
        }
      }
      if (queued < length) return null;
      const out = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const head = queue[0];
        if (!head) break;
        const part = head.subarray(0, length - filled);
        out.set(part, filled);
        filled += part.byteLength;
        if (part.byteLength === head.byteLength) queue.shift();
        else queue[0] = head.subarray(part.byteLength);
      }
      queued -= length;
      return out;
    };
    const text = (block: Uint8Array, offset: number, width: number) => {
      const field = block.subarray(offset, offset + width);
      const end = field.indexOf(0);
      return new TextDecoder().decode(
        end === -1 ? field : field.subarray(0, end),
      );
    };
    const number = (block: Uint8Array, offset: number, width: number) =>
      Number.parseInt(text(block, offset, width).trim() || "0", 8);
    let entries = 0;
    let total = 0;
    let pax: { path?: string; linkpath?: string } = {};
    /** Whether any folder on the way to `relative` is a symbolic link. */
    const throughLink = async (relative: string) => {
      const parts = relative.split("/").slice(0, -1);
      for (let index = 1; index <= parts.length; index++) {
        const stats = await lstat(
          path.join(into, ...parts.slice(0, index)),
        ).catch(() => null);
        if (stats?.isSymbolicLink()) return true;
      }
      return false;
    };
    for (;;) {
      const block = await take(BLOCK);
      if (!block) return fail("The archive ended without its end marker.");
      if (block.every((byte) => byte === 0)) return { ok: true, entries };
      let sum = 0;
      for (let index = 0; index < BLOCK; index++)
        sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
      if (sum !== number(block, 148, 8))
        return fail("An archive header's checksum does not match.");
      const type = text(block, 156, 1) || "0";
      const size = number(block, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0)
        return fail("An archive entry has an invalid size.");
      total += size;
      if (total > MAX_TOTAL_BYTES)
        return fail("The archive unpacks to more than a release may hold.");
      const body = await take(size + ((BLOCK - (size % BLOCK)) % BLOCK));
      if (!body) return fail("The archive is cut off inside an entry.");
      const content = body.subarray(0, size);
      if (type === "x") {
        pax = {};
        for (const record of new TextDecoder().decode(content).split("\n")) {
          const match = /^\d+ (path|linkpath)=(.*)$/.exec(record);
          if (match?.[1] === "path") pax.path = match[2];
          if (match?.[1] === "linkpath") pax.linkpath = match[2];
        }
        continue;
      }
      const name = (pax.path ?? text(block, 0, 100)).replace(/\/$/, "");
      const linkname = pax.linkpath ?? text(block, 157, 100);
      pax = {};
      if (++entries > MAX_ENTRIES)
        return fail("The archive holds more entries than a release may.");
      if (!plainPath(name))
        return fail(
          `The archive names ${JSON.stringify(name)}, which is outside a release.`,
        );
      if (await throughLink(name))
        return fail(`The archive writes ${name} through a symbolic link.`);
      const target = path.join(into, name);
      switch (type) {
        case "5":
          await mkdir(target, { recursive: true, mode: 0o755 });
          break;
        case "0":
          await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
          await writeFile(target, content, {
            flag: "wx",
            mode: number(block, 100, 8) & 0o111 ? 0o755 : 0o644,
          });
          break;
        case "2":
          if (!linkInside(name, linkname))
            return fail(
              `The archive's link ${name} leads outside the release.`,
            );
          await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
          await symlink(linkname, target);
          break;
        default:
          return fail(
            `The archive holds ${name} as entry type ${JSON.stringify(type)}; a release holds only files, folders and links.`,
          );
      }
    }
  },

  /** SHA-256 and size of a file, streamed. */
  async digest(file: string) {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of Bun.file(file).stream()) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    return { size, sha256: hash.digest("hex") };
  },
} as const;
