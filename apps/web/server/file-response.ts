import type { Readable } from "node:stream";
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import type { Access } from "@nimbus/api/access";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { isFsError } from "@nimbus/api/safe-path";
import { FileKind } from "@/lib/file-kind";
import { archiveEntries, folderRoot } from "./routes/archive-entries";
import { fileETag } from "./file-content";
import { zipStream } from "./zip-stream";

/**
 * File and folder downloads as web Responses, shared by the download, public
 * link and MCP routes and WebDAV GET, served by Bun.serve.
 */

export function streamBody(stream: Readable) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: unknown) => {
        if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
          if ((controller.desiredSize ?? 0) <= 0) stream.pause();
        }
      });
      stream.on("end", () => controller.close());
      stream.on("error", (error) => controller.error(error));
    },
    pull() {
      stream.resume();
    },
    cancel() {
      stream.destroy();
    },
  });
}

/**
 * The file to serve and its metadata. A GET opens it, refusing a symlink in
 * the last component as `safePath` refuses one in the others, and states the
 * open descriptor; a HEAD needs no descriptor.
 */
async function openFile(head: boolean, requested: string) {
  if (head) {
    const target = await requireExisting(requested);
    return { handle: null, stats: target.stats, absolute: target.absolute };
  }
  const target = await safePath(requested);
  let handle;
  try {
    // O_NONBLOCK: opening a FIFO would otherwise wait for a writer. It changes nothing for files.
    handle = await open(
      target.absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This file or folder no longer exists. Refresh the drive.",
      });
    if (isFsError(error, "ELOOP"))
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Symbolic links cannot be accessed through Nimbus.",
      });
    throw error;
  }
  try {
    return { handle, stats: await handle.stat(), absolute: target.absolute };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * How long a download keeps its descriptor open after the response is handed
 * to the server. Bun opens its own copy through `/proc/self/fd` while it
 * renders the response, within a millisecond of the handler returning; the
 * hold covers that with a wide margin, so the number cannot be reused for
 * another file before Bun has opened it.
 */
const descriptorHoldMs = 10_000;

/** Linux exposes every open descriptor as a path that opens the same file. */
const descriptorPaths = existsSync("/proc/self/fd");

/**
 * Serve a file, or one byte range of it. The file is opened once, without
 * following a symlink, and the headers describe that open file.
 *
 * When the path still names the opened file, unchanged, the server sends it
 * zero-copy: the body is the open descriptor's `/proc/self/fd` path, so the
 * kernel copies bytes with sendfile and a file renamed over this one is never
 * sent instead. Measured: 4 concurrent 1 GB downloads at 10.9 GB/s instead of
 * 3.6. Otherwise, or where descriptor paths do not exist, the bytes stream
 * from the open descriptor in 1 MiB reads. Either way a replaced file is
 * served whole, as the version the headers describe.
 */
export async function serveFile(
  request: Request,
  requested: string,
  access: Pick<Access, "require">,
  inline = false,
) {
  access.require(requested, "read");
  const opened = await openFile(request.method === "HEAD", requested);
  const { handle, stats, absolute } = opened;
  try {
    if (!stats.isFile())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Choose a file to download.",
      });
    const response = fileResponse(request, absolute, stats, inline);
    if (response.kind === "headers-only") {
      await handle?.close();
      return new Response(null, response.init);
    }
    if (!handle || response.length === 0) {
      await handle?.close();
      return new Response(null, response.init);
    }
    if (await stillNamed(absolute, stats)) {
      const body = Bun.file(`/proc/self/fd/${handle.fd}`).slice(
        response.start,
        response.end + 1,
      );
      // Unreferenced: an open hold never keeps the process alive on its own.
      setTimeout(() => void handle.close(), descriptorHoldMs).unref();
      return new Response(body, response.init);
    }
    const stream = handle.createReadStream({
      start: response.start,
      end: response.end,
      highWaterMark: 1 << 20,
    });
    return new Response(streamBody(stream), response.init);
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

/**
 * Whether `absolute` still names the file the headers were built from: the
 * same device and inode, with the same size and modification and change
 * times. A replacement, truncation or write since then fails the check, and
 * the download streams from the open descriptor instead.
 */
export async function stillNamed(absolute: string, described: Stats) {
  if (!descriptorPaths) return false;
  const named = await lstat(absolute).catch(() => null);
  return (
    named !== null &&
    named.dev === described.dev &&
    named.ino === described.ino &&
    named.size === described.size &&
    named.mtimeMs === described.mtimeMs &&
    named.ctimeMs === described.ctimeMs
  );
}

type FileResponse =
  | { kind: "headers-only"; init: ResponseInit }
  | {
      kind: "body";
      init: ResponseInit;
      start: number;
      end: number;
      length: number;
    };

/** Status and headers for a file response, honouring a single byte range. */
function fileResponse(
  request: Request,
  absolute: string,
  stats: Stats,
  inline: boolean,
): FileResponse {
  const filename = path.basename(absolute);
  const contentType = FileKind.previewContentType(FileKind.of(filename));
  const etag = fileETag(stats);
  const headers = new Headers({
    "Content-Type": inline ? contentType : "application/octet-stream",
    "Content-Disposition": `${inline && contentType !== "application/octet-stream" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Last-Modified": stats.mtime.toUTCString(),
    ETag: etag,
  });
  let start = 0;
  let end = stats.size - 1;
  let status = 200;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const rangeMatches =
    !ifRange ||
    ifRange === etag ||
    (Number.isFinite(Date.parse(ifRange)) &&
      stats.mtimeMs < Date.parse(ifRange) + 1000);
  const unsatisfiable = {
    kind: "headers-only",
    init: {
      status: 416,
      headers: { "Content-Range": `bytes */${stats.size}`, ETag: etag },
    },
  } as const;
  if (range && rangeMatches) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return unsatisfiable;
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    } else start = Math.max(0, stats.size - Number(match[2]));
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start < 0
    )
      return unsatisfiable;
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${stats.size}`);
  }
  const length = Math.max(0, end - start + 1);
  headers.set("Content-Length", String(length));
  return { kind: "body", init: { status, headers }, start, end, length };
}

/** Download a folder as a ZIP of its readable contents. */
export async function serveZip(
  requested: string,
  access: Access,
  head = false,
) {
  access.require(requested, "read");
  const roots = await folderRoot(requested);
  const headers = {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(requested) || "drive")}.zip`,
    "Cache-Control": "private, no-store",
  };
  if (head) return new Response(null, { headers });
  return new Response(
    zipStream(archiveEntries(roots, access), null, `the folder ${requested}`),
    { headers },
  );
}
