import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import type { Access } from "@nimbus/api/access";
import { getAccess } from "@nimbus/api/access";
import { readDirectory } from "@nimbus/api/file-browser";
import { requireExisting } from "@nimbus/api/file-operations";

import { auth } from "@/lib/auth";
import { db } from "./db";
import { createDriveStore } from "./drive-store";

export const httpDriveStore = createDriveStore(db);

export async function requestAccess(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in to access your drive.",
    });
  return getAccess(httpDriveStore, session.user.id);
}

const requestError = z.object({
  code: z.enum([
    "UNAUTHORIZED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "TOO_MANY_REQUESTS",
    "INTERNAL_SERVER_ERROR",
    "BAD_REQUEST",
  ]),
  message: z.string(),
  name: z.string().optional(),
});
const errorStatuses = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_REQUEST: 400,
} as const;

export function httpError(error: unknown) {
  // The custom server and Next's bundles can load separate copies of tRPC.
  const parsed = requestError.safeParse(error);
  if (parsed.success) {
    const status =
      parsed.data.name === "FileLockedError"
        ? 423
        : errorStatuses[parsed.data.code];
    return Response.json({ error: parsed.data.message }, { status });
  }
  console.error("Nimbus file request failed", error);
  return Response.json(
    {
      error:
        "The file operation failed. Refresh the drive to check its state, then try again. Check server logs if the problem continues.",
    },
    { status: 500 },
  );
}

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

const previewTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

export async function serveFile(
  request: Request,
  requested: string,
  access: Pick<Access, "require">,
  inline = false,
) {
  access.require(requested, "read");
  const target = await requireExisting(requested);
  if (!target.stats.isFile())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a file to download.",
    });
  const filename = path.basename(target.absolute);
  const contentType =
    previewTypes[path.extname(filename).toLowerCase()] ??
    "application/octet-stream";
  const headers = new Headers({
    "Content-Type": inline ? contentType : "application/octet-stream",
    "Content-Disposition": `${inline && contentType !== "application/octet-stream" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Last-Modified": target.stats.mtime.toUTCString(),
    ETag: `"${target.stats.mtimeMs}-${target.stats.size}"`,
  });
  let start = 0;
  let end = target.stats.size - 1;
  let status = 200;
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const rangeMatches =
    !ifRange ||
    ifRange === headers.get("etag") ||
    (Number.isFinite(Date.parse(ifRange)) &&
      target.stats.mtimeMs < Date.parse(ifRange) + 1000);
  if (range && rangeMatches) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${target.stats.size}` },
      });
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    } else start = Math.max(0, target.stats.size - Number(match[2]));
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start < 0
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${target.stats.size}` },
      });
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${target.stats.size}`);
  }
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  const body =
    request.method === "HEAD" || target.stats.size === 0
      ? null
      : streamBody(createReadStream(target.absolute, { start, end }));
  return new Response(body, { status, headers });
}

export async function serveZip(
  requested: string,
  access: Access,
  head = false,
) {
  access.require(requested, "read");
  const root = await requireExisting(requested);
  if (!root.stats.isDirectory())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a folder for ZIP download.",
    });
  const headers = {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(root.absolute) || "drive")}.zip`,
    "Cache-Control": "private, no-store",
  };
  if (head) return new Response(null, { headers });
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const body = streamBody(archive);
  const pending = [requested];
  const append = async () => {
    while (pending.length) {
      const directory = pending.shift();
      if (directory === undefined) break;
      for (const entry of await readDirectory(directory, access)) {
        if (!access.can(entry.path, "read")) continue;
        const relative = requested
          ? entry.path.slice(requested.length + 1)
          : entry.path;
        if (entry.type === "dir") {
          archive.append("", { name: `${relative}/` });
          pending.push(entry.path);
        } else {
          const target = await requireExisting(entry.path);
          archive.file(target.absolute, { name: relative });
        }
      }
    }
    await archive.finalize();
  };
  void append().catch((error: unknown) =>
    archive.destroy(
      error instanceof Error ? error : new Error("ZIP generation failed."),
    ),
  );
  return new Response(body, { headers });
}
