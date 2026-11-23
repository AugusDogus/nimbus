import type { Readable } from "node:stream";
import { existsSync, type Stats } from "node:fs";
import { lstat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import type { Access } from "@nimbus/api/access";
import { requireExisting, safePath } from "@nimbus/api/file-operations";
import { isFsError } from "@nimbus/api/safe-path";
import { FileKind } from "@/lib/file-kind";
import { DriveFile } from "@nimbus/api/drive-file";
import { archiveEntries, folderRoot } from "./routes/archive-entries";
import { ContentDisposition } from "./content-disposition";
import { fileETag } from "./file-content";
import { FileVersion } from "./file-version";
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
 * The file to serve and its metadata. A GET opens it without following a
 * symlink swapped in anywhere along its path since `safePath` checked it, and
 * states the open descriptor; a HEAD needs no descriptor.
 */
async function openFile(head: boolean, requested: string) {
  if (head) {
    const target = await requireExisting(requested);
    return { handle: null, stats: target.stats, absolute: target.absolute };
  }
  const target = await safePath(requested);
  const { handle, stats } = await DriveFile.openForReading(target.absolute);
  return { handle, stats, absolute: target.absolute };
}

/**
 * How long a zero-copy download keeps its descriptor open after the response
 * is handed to the server. Bun opens its own copy through `/proc/self/fd` as
 * it renders the response, in the same turn of the event loop as the handler
 * returns (measured: before the next `setImmediate`); the hold covers that
 * with a wide margin, so the number cannot be reused for another file before
 * Bun has opened it. Bun reports neither when it opened the copy nor when the
 * response finished, so the hold is a fixed time.
 */
const descriptorHoldMs = 1_000;

/** Zero-copy downloads holding a descriptor at once. Beyond this, downloads stream. */
export const maxHeldDescriptors = 512;
/** Slots taken, including ones whose path check is still running. */
let heldDescriptors = 0;
/** Closes one held descriptor early; each removes itself once run. */
const holds = new Set<() => Promise<void>>();

/** Descriptors held by zero-copy downloads right now. */
export const heldDescriptorCount = () => holds.size;

/** Close every held descriptor now, as the hold timers would, so tests need not wait. */
export async function releaseHeldDescriptorsForTest() {
  await Promise.all([...holds].map((release) => release()));
}

/** Files up to this size are read into memory and their descriptor closed at once. */
const bufferedBytes = 64 * 1024;

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
  body: (version: FileVersion) => ServedBody = () => "fast",
  validators: Validators = {},
) {
  access.require(requested, "read");
  const opened = await openFile(request.method === "HEAD", requested);
  const response = await respond(request, opened, inline, body, validators);
  if (!versions.has(response))
    versions.set(response, FileVersion.of(opened.stats));
  return response;
}

/**
 * How a body larger than `bufferedBytes` is sent. `fast` goes zero-copy where it can. `confirmed`
 * streams from the open descriptor and confirms the file's version after reading each chunk and
 * before sending it, ending the body as failed when it changed: a write moves the modification
 * time before it changes a byte, so every byte sent belongs to the version `servedVersion`
 * names. For a response that may go uncounted on a proof of that version: `serveFile` asks
 * `body` with the version it opened, so the choice rests on the file actually sent. Smaller
 * bodies are always read whole and confirmed once.
 */
export type ServedBody = "fast" | "confirmed";

/**
 * The version of the file `response` serves, for responses from `serveFile`, or null when it
 * changed while it was read, so nothing may treat the bytes as that version.
 */
export const servedVersion = (response: Response): FileVersion | null =>
  versions.get(response) ?? null;

/** Each `serveFile` response's file version, read from the same open file as its bytes. */
const versions = new WeakMap<Response, FileVersion | null>();

/** Overrides of a file response's validators: its ETag, from the file's stats, and caching. */
export type Validators = {
  etag?: (stats: Stats) => string;
  cacheControl?: string;
};

async function respond(
  request: Request,
  opened: Awaited<ReturnType<typeof openFile>>,
  inline: boolean,
  body: (version: FileVersion) => ServedBody,
  validators: Validators,
) {
  const { handle, stats, absolute } = opened;
  try {
    if (!stats.isFile())
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Choose a file to download.",
      });
    const response = fileResponse(
      request,
      absolute,
      stats,
      inline,
      path.basename(absolute),
      {
        etag: validators.etag?.(stats),
        cacheControl: validators.cacheControl,
      },
    );
    if (response.kind === "headers-only") {
      await handle?.close();
      return new Response(null, response.init);
    }
    if (!handle || response.length === 0) {
      await handle?.close();
      return new Response(null, response.init);
    }
    if (response.length <= bufferedBytes) {
      const bytes = new Uint8Array(response.length);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          read,
          bytes.length - read,
          response.start + read,
        );
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      // Rewritten in place since it was stated: the bytes are not the version the headers name.
      const unchanged =
        FileVersion.of(await handle.stat()) === FileVersion.of(stats);
      await handle.close();
      // Shortened in place since it was opened: send what remains, with that length.
      const headers = new Headers(response.init.headers);
      headers.set("Content-Length", String(read));
      if (response.init.status === 206 && read > 0)
        headers.set(
          "Content-Range",
          `bytes ${response.start}-${response.start + read - 1}/${stats.size}`,
        );
      const served = new Response(bytes.subarray(0, read), {
        status: response.init.status,
        headers,
      });
      versions.set(served, unchanged ? FileVersion.of(stats) : null);
      return served;
    }
    if (body(FileVersion.of(stats)) === "confirmed")
      return new Response(
        confirmedBody(handle, stats, response.start, response.end),
        response.init,
      );
    if (heldDescriptors < maxHeldDescriptors) {
      // The slot is taken before the check awaits, so concurrent downloads cannot all pass it.
      heldDescriptors++;
      if (await stillNamed(absolute, stats)) {
        const body = Bun.file(`/proc/self/fd/${handle.fd}`).slice(
          response.start,
          response.end + 1,
        );
        const release = async () => {
          if (!holds.delete(release)) return;
          clearTimeout(timer);
          heldDescriptors--;
          await handle.close();
        };
        // Unreferenced: an open hold never keeps the process alive on its own.
        const timer = setTimeout(() => void release(), descriptorHoldMs);
        timer.unref();
        holds.add(release);
        return new Response(body, response.init);
      }
      heldDescriptors--;
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
 * What else a confirmed body checks before each chunk, for responses whose right to be sent can
 * end while they are sent: `allowed` returns why the rest may not go out, or null, and `done`
 * runs once when the body ends, however it ends.
 */
export type BodyWatch = { allowed: () => string | null; done: () => void };

/** Bytes `start` to `end` of the open file, each chunk confirmed as version `stats` before it is sent. */
function confirmedBody(
  handle: FileHandle,
  stats: Stats,
  start: number,
  end: number,
  watch: BodyWatch = { allowed: () => null, done: () => undefined },
) {
  const version = FileVersion.of(stats);
  let position = start;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    watch.done();
    await handle.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const length = Math.min(1 << 20, end + 1 - position);
        if (length <= 0) {
          await close();
          controller.close();
          return;
        }
        const refused = watch.allowed();
        if (refused !== null) throw new Error(refused);
        const chunk = new Uint8Array(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead === 0 || FileVersion.of(await handle.stat()) !== version)
          throw new Error(
            "The file changed while it was being sent, so the transfer was stopped. The bytes already sent belong to the version first served; download it again for the current one.",
          );
        position += bytesRead;
        controller.enqueue(chunk.subarray(0, bytesRead));
      } catch (error) {
        await close().catch(() => undefined);
        controller.error(error);
      }
    },
    cancel: close,
  });
}

/** What `serveOpened` did: served the file, or found it changed before any byte was sent. */
export type OpenedResponse =
  | { kind: "served"; response: Response }
  | { kind: "changed" }
  /** `watch` refused before any byte was sent, for this reason. */
  | { kind: "refused"; reason: string };

/**
 * Serve an already opened and checked regular file, or one byte range of it, inline as
 * `filename`, for callers that opened it themselves (see LibraryAccess.open). The body always
 * streams in confirmed mode: each chunk is checked against the version opened and against
 * `watch` before it is sent, so a body ends as failed when the file changes or the caller's
 * right to send it ends. The handle is always closed. Small files are read whole and checked once.
 */
export async function serveOpened(
  request: Request,
  opened: { handle: FileHandle; stats: Stats },
  options: {
    filename: string;
    etag: string;
    cacheControl: string;
    /**
     * The most bytes one ranged answer carries. A larger range is answered with its first
     * `window` bytes, as `Content-Range` states, read whole and sent with an exact length; the
     * client asks for the rest. Only an answer without a range streams.
     */
    window: number;
    watch?: BodyWatch;
  },
): Promise<OpenedResponse> {
  const { handle, stats } = opened;
  const watch = options.watch ?? {
    allowed: () => null,
    done: () => undefined,
  };
  let streaming = false;
  try {
    const response = fileResponse(
      request,
      options.filename,
      stats,
      true,
      options.filename,
      { etag: options.etag, cacheControl: options.cacheControl },
    );
    if (
      response.kind === "headers-only" ||
      request.method === "HEAD" ||
      response.length === 0
    )
      return { kind: "served", response: new Response(null, response.init) };
    if (response.init.status === 206 && response.length > options.window) {
      response.end = response.start + options.window - 1;
      response.length = options.window;
      const headers = new Headers(response.init.headers);
      headers.set(
        "Content-Range",
        `bytes ${response.start}-${response.end}/${stats.size}`,
      );
      headers.set("Content-Length", String(response.length));
      response.init = { ...response.init, headers };
    }
    if (response.length <= Math.max(bufferedBytes, options.window)) {
      const bytes = new Uint8Array(response.length);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          read,
          bytes.length - read,
          response.start + read,
        );
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      if (
        read !== bytes.length ||
        FileVersion.of(await handle.stat()) !== FileVersion.of(stats)
      )
        return { kind: "changed" };
      // Read whole after every check, so a refusal since then still stops it here.
      const refused = watch.allowed();
      if (refused !== null) return { kind: "refused", reason: refused };
      return {
        kind: "served",
        response: new Response(bytes, response.init),
      };
    }
    streaming = true;
    return {
      kind: "served",
      response: new Response(
        confirmedBody(handle, stats, response.start, response.end, watch),
        response.init,
      ),
    };
  } finally {
    if (!streaming) {
      watch.done();
      await handle.close();
    }
  }
}

/**
 * Serve a file that Nimbus never changes once it is written, such as a version
 * payload, or one byte range of it, as the attachment `filename`. Nothing
 * replaces it in place, so it goes out zero-copy from its path.
 */
export async function serveStoredFile(
  request: Request,
  absolute: string,
  filename: string,
) {
  const stats = await lstat(absolute).catch((error: unknown) => {
    if (isFsError(error, "ENOENT"))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "That version no longer exists. Refresh the version list.",
      });
    throw error;
  });
  if (!stats.isFile())
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That version no longer exists. Refresh the version list.",
    });
  const response = fileResponse(request, absolute, stats, false, filename);
  if (response.kind === "headers-only" || response.length === 0)
    return new Response(null, response.init);
  return new Response(
    Bun.file(absolute).slice(response.start, response.end + 1),
    response.init,
  );
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

/** Entity tags listed in an If-Match or If-None-Match header. */
const listedTags = (header: string) =>
  header.split(",").map((tag) => tag.trim());
const weak = (tag: string) => tag.replace(/^W\//, "");

/**
 * The precondition status for a GET or HEAD (RFC 9110, section 13.2.2), or null to serve it.
 * Last-Modified has whole seconds, so dates compare against the modification time's second.
 */
function precondition(request: Request, etag: string, stats: Stats) {
  const modified = Math.floor(stats.mtimeMs / 1000) * 1000;
  const date = (name: string) => {
    const value = Date.parse(request.headers.get(name) ?? "");
    return Number.isFinite(value) ? value : null;
  };
  const ifMatch = request.headers.get("if-match");
  if (ifMatch !== null) {
    const tags = listedTags(ifMatch);
    // Strong comparison: a weak tag never matches.
    if (!tags.includes("*") && !tags.includes(etag)) return 412;
  } else {
    const since = date("if-unmodified-since");
    if (since !== null && modified > since) return 412;
  }
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch !== null) {
    const tags = listedTags(ifNoneMatch);
    if (tags.includes("*") || tags.some((tag) => weak(tag) === etag))
      return 304;
  } else {
    const since = date("if-modified-since");
    if (since !== null && modified <= since) return 304;
  }
  return null;
}

/**
 * The single byte range to send, "unsatisfiable", or null to send the whole file. Ranges this
 * server does not serve (several ranges, an unknown unit, malformed or inverted ones) are
 * ignored, as RFC 9110 section 14.2 allows, so the client gets the whole file.
 */
function byteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0 || size === 0) return "unsatisfiable" as const;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const last = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last)) return null;
  if (match[2] && last < start) return null;
  if (start >= size) return "unsatisfiable" as const;
  return { start, end: Math.min(last, size - 1) };
}

/** Status and headers for a file response, honouring preconditions and a single byte range. */
function fileResponse(
  request: Request,
  absolute: string,
  stats: Stats,
  inline: boolean,
  filename = path.basename(absolute),
  {
    etag = fileETag(stats),
    cacheControl = "private, no-store",
  }: { etag?: string | undefined; cacheControl?: string | undefined } = {},
): FileResponse {
  const contentType = FileKind.previewContentType(FileKind.of(filename));
  const validators = {
    ETag: etag,
    "Last-Modified": stats.mtime.toUTCString(),
    "Cache-Control": cacheControl,
  };
  const failed = precondition(request, etag, stats);
  if (failed !== null)
    return {
      kind: "headers-only",
      init: { status: failed, headers: validators },
    };
  const headers = new Headers({
    "Content-Type": inline ? contentType : "application/octet-stream",
    "Content-Disposition": ContentDisposition.header(
      inline && contentType !== "application/octet-stream"
        ? "inline"
        : "attachment",
      filename,
    ),
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    ...validators,
  });
  let start = 0;
  let end = stats.size - 1;
  let status = 200;
  const rangeHeader = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const rangeMatches =
    !ifRange ||
    ifRange === etag ||
    (Number.isFinite(Date.parse(ifRange)) &&
      stats.mtimeMs < Date.parse(ifRange) + 1000);
  const range =
    rangeHeader && rangeMatches ? byteRange(rangeHeader, stats.size) : null;
  if (range === "unsatisfiable")
    return {
      kind: "headers-only",
      init: {
        status: 416,
        headers: {
          "Content-Range": `bytes */${stats.size}`,
          ETag: etag,
          "Cache-Control": cacheControl,
        },
      },
    };
  if (range) {
    ({ start, end } = range);
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
    "Content-Disposition": ContentDisposition.header(
      "attachment",
      `${path.basename(requested) || "drive"}.zip`,
    ),
    "Cache-Control": "private, no-store",
  };
  if (head) return new Response(null, { headers });
  return new Response(
    zipStream(archiveEntries(roots, access), null, `the folder ${requested}`),
    { headers },
  );
}
