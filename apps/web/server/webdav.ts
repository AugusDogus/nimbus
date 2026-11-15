import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getAccess } from "@nimbus/api/access";
import { getDataRoot } from "@nimbus/api/data-root";
import {
  entryAt,
  readDirectory,
  type FileEntry,
} from "@nimbus/api/file-browser";
import { publishFileEvent } from "@nimbus/api/file-events";
import {
  fileLock,
  lockFile,
  mutateFiles,
  unlockFile,
  webDAVLockTokens,
} from "@nimbus/api/file-mutations";
import {
  copyItem,
  moveItem,
  requireExisting,
  requireMutable,
  requireUnused,
  safePath,
  trashItem,
} from "@nimbus/api/file-operations";
import { isApiError, isFsError } from "@nimbus/api/safe-path";
import { httpDriveStore, httpError, serveFile } from "./http-files";

const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const davHref = (entry: Pick<FileEntry, "path" | "type">) =>
  `/dav/${entry.path.split("/").map(encodeURIComponent).join("/")}${entry.type === "dir" && entry.path ? "/" : ""}`;
const allowedMethods = [
  "OPTIONS",
  "GET",
  "HEAD",
  "PROPFIND",
  "PUT",
  "MKCOL",
  "DELETE",
  "MOVE",
  "COPY",
  "LOCK",
  "UNLOCK",
];

async function authenticate(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic "))
    throw new TRPCError({ code: "UNAUTHORIZED" });
  const credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = credentials.indexOf(":");
  if (colon < 1) throw new TRPCError({ code: "UNAUTHORIZED" });
  const email = credentials.slice(0, colon);
  const token = credentials.slice(colon + 1);
  const password = await httpDriveStore.findAppPassword(
    createHash("sha256").update(token).digest("hex"),
  );
  if (!password) throw new TRPCError({ code: "UNAUTHORIZED" });
  const access = await getAccess(httpDriveStore, password.userId);
  if (access.user.email.toLowerCase() !== email.toLowerCase())
    throw new TRPCError({ code: "UNAUTHORIZED" });
  return access;
}

function activeLock(path: string) {
  const lock = fileLock(path);
  return lock
    ? `<d:activelock><d:locktype><d:write/></d:locktype><d:lockscope><d:exclusive/></d:lockscope><d:depth>infinity</d:depth><d:timeout>Second-${Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000))}</d:timeout><d:locktoken><d:href>${xml(lock.token)}</d:href></d:locktoken><d:lockroot><d:href>${xml(davHref({ path, type: "file" }))}</d:href></d:lockroot></d:activelock>`
    : "";
}

function propertyResponse(entry: FileEntry) {
  return `<d:response><d:href>${xml(davHref(entry))}</d:href><d:propstat><d:prop><d:displayname>${xml(entry.name)}</d:displayname><d:resourcetype>${entry.type === "dir" ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${entry.size}</d:getcontentlength><d:getlastmodified>${new Date(entry.mtime).toUTCString()}</d:getlastmodified><d:getetag>"${entry.mtime}-${entry.size}"</d:getetag><d:supportedlock><d:lockentry><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockentry></d:supportedlock><d:lockdiscovery>${activeLock(entry.path)}</d:lockdiscovery></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function xmlResponse(body: string, status = 207, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/xml; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(`<?xml version="1.0" encoding="utf-8"?>${body}`, {
    status,
    headers,
  });
}

function decodedPath(pathname: string) {
  if (pathname !== "/dav" && !pathname.startsWith("/dav/"))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The destination must be on this drive.",
    });
  try {
    return decodeURIComponent(pathname.slice(4).replace(/^\//, "")).replace(
      /\/$/,
      "",
    );
  } catch {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "The WebDAV path contains invalid encoding.",
    });
  }
}

function matchesETag(header: string, tag: string) {
  return (
    header === "*" || header.split(",").some((value) => value.trim() === tag)
  );
}

async function putFile(request: Request, requested: string) {
  const temporaryDirectory = path.join(getDataRoot(), ".nimbus", "uploads");
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = path.join(temporaryDirectory, `${randomUUID()}.dav`);
  try {
    await Bun.write(temporary, new Response(request.body));
    const access = await authenticate(request);
    return await mutateFiles(
      [requested],
      {
        userId: access.user.id,
        lockTokens: webDAVLockTokens(request.headers.get("if")),
      },
      async () => {
        const currentAccess = await authenticate(request);
        currentAccess.require(requested, "write");
        const target = await safePath(requested);
        let previous: FileEntry | null = null;
        try {
          previous = await entryAt(requested);
        } catch (error) {
          if (!isApiError(error, "NOT_FOUND")) throw error;
        }
        if (previous?.type === "dir")
          return new Response(null, { status: 409 });
        const tag = previous ? `"${previous.mtime}-${previous.size}"` : "";
        const noneMatch = request.headers.get("if-none-match");
        const match = request.headers.get("if-match");
        if (
          (noneMatch && previous && matchesETag(noneMatch, tag)) ||
          (match && (!previous || !matchesETag(match, tag)))
        )
          return new Response(null, { status: 412 });
        await rename(temporary, target.absolute);
        publishFileEvent({
          path: target.absolute,
          event: previous ? "change" : "rename",
          ts: Date.now(),
        });
        return new Response(null, { status: previous ? 204 : 201 });
      },
    );
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function handleWebDAV(request: Request): Promise<Response> {
  try {
    const access = await authenticate(request);
    const url = new URL(request.url);
    const target = await safePath(decodedPath(url.pathname));
    const method = request.method;
    if (!allowedMethods.includes(method))
      return new Response(null, {
        status: 405,
        headers: { Allow: allowedMethods.join(", ") },
      });
    if (method === "OPTIONS")
      return new Response(null, {
        status: 204,
        headers: {
          DAV: "1, 2",
          Allow: allowedMethods.join(", "),
          "MS-Author-Via": "DAV",
        },
      });
    if (method === "GET" || method === "HEAD")
      return await serveFile(request, target.relative, access);
    if (method === "PROPFIND") {
      const depth = request.headers.get("depth") ?? "infinity";
      if (depth !== "0" && depth !== "1")
        return xmlResponse(
          '<d:error xmlns:d="DAV:"><d:propfind-finite-depth/></d:error>',
          403,
        );
      if (!access.canBrowse(target.relative))
        throw new TRPCError({ code: "FORBIDDEN" });
      const entry = await entryAt(target.relative);
      const entries =
        entry.type === "dir" && depth === "1"
          ? [entry, ...(await readDirectory(target.relative, access))]
          : [entry];
      return xmlResponse(
        `<d:multistatus xmlns:d="DAV:">${entries.map(propertyResponse).join("")}</d:multistatus>`,
      );
    }
    access.require(target.relative, method === "COPY" ? "read" : "write");
    const credentials = {
      userId: access.user.id,
      lockTokens: webDAVLockTokens(request.headers.get("if")),
    };
    if (method === "LOCK") {
      return await mutateFiles([target.relative], credentials, async () => {
        const currentAccess = await authenticate(request);
        currentAccess.require(target.relative, "write");
        let created = false;
        try {
          await requireExisting(target.relative);
        } catch (error) {
          if (!isApiError(error, "NOT_FOUND")) throw error;
          const destination = await safePath(target.relative);
          await writeFile(destination.absolute, "", { flag: "wx" });
          created = true;
          publishFileEvent({
            path: destination.absolute,
            event: "rename",
            ts: Date.now(),
          });
        }
        const lock = lockFile(target.relative, credentials);
        return xmlResponse(
          `<d:prop xmlns:d="DAV:"><d:lockdiscovery>${activeLock(target.relative)}</d:lockdiscovery></d:prop>`,
          created ? 201 : 200,
          { "Lock-Token": `<${lock.token}>` },
        );
      });
    }
    if (method === "UNLOCK") {
      unlockFile(
        target.relative,
        access.user.id,
        request.headers.get("lock-token") ?? "",
      );
      return new Response(null, { status: 204 });
    }
    requireMutable(target.relative);
    if (method === "DELETE") {
      await trashItem(
        httpDriveStore,
        access,
        target.relative,
        credentials.lockTokens,
      );
      return new Response(null, { status: 204 });
    }
    if (method === "MKCOL") {
      if (request.body && (await request.arrayBuffer()).byteLength > 0)
        return new Response(null, { status: 415 });
      return await mutateFiles([target.relative], credentials, async () => {
        const currentAccess = await authenticate(request);
        currentAccess.require(target.relative, "write");
        const destination = await safePath(target.relative);
        await requireUnused(destination.absolute);
        await mkdir(destination.absolute);
        publishFileEvent({
          path: destination.absolute,
          event: "rename",
          ts: Date.now(),
        });
        return new Response(null, { status: 201 });
      });
    }
    if (method === "PUT") return await putFile(request, target.relative);
    if (method === "MOVE" || method === "COPY") {
      const destinationHeader = request.headers.get("destination");
      if (!destinationHeader)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A Destination header is required.",
        });
      let destinationUrl: URL;
      try {
        destinationUrl = new URL(destinationHeader, request.url);
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The Destination header must contain a valid drive URL.",
        });
      }
      if (destinationUrl.origin !== url.origin)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The destination must be on this drive.",
        });
      const destination = await safePath(decodedPath(destinationUrl.pathname));
      requireMutable(destination.relative);
      access.require(destination.relative, "write");
      // RFC 4918, section 10.6: Overwrite defaults to T.
      const overwrite = (request.headers.get("overwrite") ?? "T").trim().toUpperCase();
      if (overwrite !== "T" && overwrite !== "F")
        return new Response("Overwrite must be T or F.", { status: 400 });
      const depth = (request.headers.get("depth") ?? "infinity").trim().toLowerCase();
      if (depth !== "infinity" && (method === "MOVE" || depth !== "0"))
        return new Response(
          `${method} supports Depth: infinity${method === "COPY" ? " or 0" : ""}.`,
          { status: 400 },
        );
      const options = {
        lockTokens: credentials.lockTokens,
        existing: overwrite === "T" ? ("replace" as const) : ("refuse" as const),
      };
      try {
        const result =
          method === "COPY"
            ? await copyItem(httpDriveStore, access, target.relative, destination.relative, {
                ...options,
                depth: depth === "0" ? "0" : "infinity",
              })
            : await moveItem(httpDriveStore, access, target.relative, destination.relative, options);
        return new Response(null, { status: result.replaced ? 204 : 201 });
      } catch (error) {
        // An existing destination with Overwrite: F is a failed precondition, not a conflict.
        if (
          isApiError(error, "CONFLICT") &&
          !(error instanceof Error && error.name === "FileLockedError")
        )
          return new Response(null, { status: 412 });
        // Source and destination overlap, or the drive root was named.
        if (isApiError(error, "BAD_REQUEST"))
          return new Response(null, { status: 403 });
        throw error;
      }
    }
    return new Response(null, { status: 405 });
  } catch (error) {
    if (isApiError(error, "UNAUTHORIZED"))
      return new Response("Use your email and a Nimbus app password.", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Nimbus", charset="UTF-8"',
        },
      });
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      return new Response("Parent folder does not exist.", { status: 409 });
    return httpError(error);
  }
}
