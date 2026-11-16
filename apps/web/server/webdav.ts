import { createHash } from "node:crypto";
import { lstat, mkdir, utimes, writeFile } from "node:fs/promises";
import { TRPCError } from "@trpc/server";
import { getAccess, type Access } from "@nimbus/api/access";
import { getDataRoot } from "@nimbus/api/data-root";
import {
  entryAt,
  readDirectory,
  type StatedEntry,
} from "@nimbus/api/file-browser";
import { commitStagedFile, fileTag, stageFile } from "@nimbus/api/file-content";
import { publishFileEvent } from "@nimbus/api/file-events";
import {
  lockFile,
  locksCovering,
  maxLockSeconds,
  mutateFiles,
  refreshLock,
  requireUnlocked,
  unlockFile,
  type LockDepth,
  type LockScope,
  type MutationCredentials,
} from "@nimbus/api/file-mutations";
import {
  copyItem,
  moveItem,
  requireExisting,
  requireMutable,
  safePath,
  trashItem,
} from "@nimbus/api/file-operations";
import { FilesystemCapacity } from "@nimbus/api/filesystem-capacity";
import { FileVersions } from "@nimbus/api/file-versions";
import { isApiError, isFsError } from "@nimbus/api/safe-path";
import { recordAudit } from "@nimbus/api/audit";
import { ClientIp } from "./client-ip";
import { serveFile } from "./file-response";
import { httpDriveStore, httpError } from "./http-files";
import { RateLimiter } from "./rate-limit";
import {
  evaluateIfHeader,
  parseIfHeader,
  submittedLockTokens,
  type IfHeader,
} from "./webdav-if";
import {
  lockDiscovery,
  parsePropertyUpdate,
  parsePropfind,
  planPropertyUpdate,
  propfindResponse,
  proppatchResponse,
  type PropfindContext,
} from "./webdav-properties";
import {
  DAV,
  child,
  escapeXml,
  maxXmlBytes,
  parseXml,
  serializeXml,
  type XmlElement,
} from "./webdav-xml";

const allowedMethods = [
  "OPTIONS",
  "GET",
  "HEAD",
  "PROPFIND",
  "PROPPATCH",
  "PUT",
  "MKCOL",
  "DELETE",
  "MOVE",
  "COPY",
  "LOCK",
  "UNLOCK",
];
const MICROSOFT = "urn:schemas-microsoft-com:";

// Counts wrong credentials per client. Requests without credentials (the usual
// first request of a WebDAV client) are challenged, not counted.
const failedLogins = RateLimiter.shared("webdav-auth-failures", {
  limit: 20,
  windowMs: 10 * 60 * 1000,
});
const clientKey = (request: Request) =>
  ClientIp.bucket(ClientIp.fromHeaders(request.headers));

function throttled(request: Request) {
  if (!request.headers.get("authorization")?.startsWith("Basic ")) return null;
  const decision = failedLogins.check(clientKey(request));
  if (decision.allowed) return null;
  const minutes = Math.ceil(decision.retryAfterSeconds / 60);
  return new Response(
    `Too many failed WebDAV sign-ins from this address. Wait ${minutes === 1 ? "a minute" : `${minutes} minutes`}, then check the email and app password in your client.`,
    {
      status: 429,
      headers: { "Retry-After": String(decision.retryAfterSeconds) },
    },
  );
}

async function authenticate(request: Request) {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic "))
    throw new TRPCError({ code: "UNAUTHORIZED" });
  const credentials = Buffer.from(header.slice(6), "base64").toString("utf8");
  const colon = credentials.indexOf(":");
  const email = colon < 1 ? "" : credentials.slice(0, colon);
  const reject = () => {
    failedLogins.consume(clientKey(request));
    recordAudit({
      action: "webdav.auth_failed",
      actor: {
        type: "anonymous",
        ...(email && { label: email.slice(0, 320) }),
      },
    });
    return new TRPCError({ code: "UNAUTHORIZED" });
  };
  if (colon < 1) throw reject();
  const token = credentials.slice(colon + 1);
  // App passwords are 256-bit random tokens, so a fast hash is the right lookup key.
  const password = await httpDriveStore.findAppPassword(
    createHash("sha256").update(token).digest("hex"),
  );
  if (!password) throw reject();
  const access = await getAccess(httpDriveStore, password.userId);
  if (access.user.email.toLowerCase() !== email.toLowerCase()) throw reject();
  return access;
}

/** XML responses carry an exact Content-Length; some clients mishandle chunked multistatus. */
function xmlResponse(body: string, status = 207, extraHeaders?: HeadersInit) {
  const text = `<?xml version="1.0" encoding="utf-8"?>${body}`;
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/xml; charset=utf-8");
  headers.set("Content-Length", String(Buffer.byteLength(text)));
  headers.set("Cache-Control", "no-store");
  return new Response(text, { status, headers });
}

const textResponse = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

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

/** Read an XML body without buffering more than the size limit. An empty body is null. */
async function readXml(
  request: Request,
): Promise<
  { ok: true; value: XmlElement | null } | { ok: false; response: Response }
> {
  const tooLarge = {
    ok: false as const,
    response: textResponse(
      413,
      `WebDAV XML bodies are limited to ${maxXmlBytes} bytes.`,
    ),
  };
  if (Number(request.headers.get("content-length") ?? 0) > maxXmlBytes)
    return tooLarge;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxXmlBytes) {
      await reader.cancel();
      return tooLarge;
    }
    chunks.push(chunk.value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return { ok: true, value: null };
  const parsed = parseXml(text);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : { ok: false, response: textResponse(400, parsed.error.message) };
}

async function entryOrNull(relative: string) {
  try {
    return await entryAt(relative);
  } catch (error) {
    if (isApiError(error, "NOT_FOUND")) return null;
    throw error;
  }
}

/** Whether the If header holds for this request (RFC 4918, section 10.4.2). */
function ifHeaderHolds(lists: IfHeader, requestUrl: URL, target: string) {
  return evaluateIfHeader(lists, async (resource) => {
    let relative = target;
    if (resource !== null) {
      let url: URL;
      try {
        url = new URL(resource, requestUrl);
      } catch {
        return null;
      }
      if (url.origin !== requestUrl.origin) return null;
      try {
        relative = (await safePath(decodedPath(url.pathname))).relative;
      } catch {
        return null;
      }
    }
    const entry = await entryOrNull(relative);
    return {
      etag: entry ? fileTag(entry) : null,
      lockTokens: locksCovering(relative).map((lock) => lock.token),
    };
  });
}

/** Seconds from a `Timeout` header, capped at the server's maximum. */
function lockTimeout(header: string | null) {
  for (const value of (header ?? "").split(",").map((part) => part.trim())) {
    if (value.toLowerCase() === "infinite") return maxLockSeconds;
    const seconds = /^Second-(\d+)$/i.exec(value)?.[1];
    if (seconds) return Math.max(1, Math.min(maxLockSeconds, Number(seconds)));
  }
  return maxLockSeconds;
}

/** Unix seconds from rclone's and ownCloud's `X-OC-Mtime` header. */
function requestedMtime(request: Request) {
  const header = request.headers.get("x-oc-mtime");
  if (header === null || !/^\d{1,12}$/.test(header.trim())) return null;
  return new Date(Number(header.trim()) * 1000);
}

/** Apply a client-supplied modification time to a file, keeping its access time. */
async function setMtime(absolute: string, mtime: Date) {
  const stats = await lstat(absolute);
  if (stats.isFile()) await utimes(absolute, stats.atime, mtime);
}

async function propfind(request: Request, access: Access, target: string) {
  const depth = request.headers.get("depth") ?? "infinity";
  if (depth !== "0" && depth !== "1")
    return xmlResponse(
      '<d:error xmlns:d="DAV:"><d:propfind-finite-depth/></d:error>',
      403,
    );
  const body = await readXml(request);
  if (!body.ok) return body.response;
  const parsed = parsePropfind(body.value);
  if (!parsed.ok) return textResponse(400, parsed.message);
  if (!access.canBrowse(target)) throw new TRPCError({ code: "FORBIDDEN" });
  const entry = await entryAt(target);
  const entries: StatedEntry[] =
    entry.type === "dir" && depth === "1"
      ? [entry, ...(await readDirectory(target, access))]
      : [entry];
  const dead = await httpDriveStore.davProperties(
    entries.map((item) => item.path),
  );
  let capacity:
    | Promise<Awaited<ReturnType<typeof FilesystemCapacity.read>>>
    | undefined;
  const context: PropfindContext = {
    locks: locksCovering,
    capacity: () => (capacity ??= FilesystemCapacity.read(getDataRoot())),
  };
  const responses = [];
  for (const item of entries)
    responses.push(
      await propfindResponse(
        item,
        parsed.value,
        dead.get(item.path) ?? [],
        context,
      ),
    );
  return xmlResponse(
    `<d:multistatus xmlns:d="DAV:">${responses.join("")}</d:multistatus>`,
  );
}

async function proppatch(
  request: Request,
  target: string,
  credentials: MutationCredentials,
) {
  const body = await readXml(request);
  if (!body.ok) return body.response;
  const updates = parsePropertyUpdate(body.value);
  if (!updates.ok) return textResponse(400, updates.message);
  return mutateFiles([target], credentials, async () => {
    (await authenticate(request)).require(target, "write");
    const existing = await requireExisting(target);
    const type = existing.stats.isDirectory() ? "dir" : "file";
    const plan = planPropertyUpdate(updates.value);
    if (plan.kind === "reject")
      return xmlResponse(proppatchResponse(target, type, plan.statuses));
    await httpDriveStore.patchDavProperties(target, plan.set, plan.remove);
    // Windows Explorer preserves file times by setting this property after an upload.
    const modified = updates.value.findLast(
      (update) =>
        update.name.namespace === MICROSOFT &&
        update.name.local === "Win32LastModifiedTime",
    );
    if (
      modified?.kind === "set" &&
      Number.isFinite(Date.parse(modified.text))
    ) {
      await setMtime(existing.absolute, new Date(Date.parse(modified.text)));
      publishFileEvent({
        path: existing.absolute,
        event: "change",
        ts: Date.now(),
      });
    }
    return xmlResponse(
      proppatchResponse(
        target,
        type,
        plan.names.map((name) => ({ name, status: 200 })),
      ),
    );
  });
}

async function lock(
  request: Request,
  target: string,
  credentials: MutationCredentials,
) {
  const body = await readXml(request);
  if (!body.ok) return body.response;
  const timeoutSeconds = lockTimeout(request.headers.get("timeout"));
  if (!body.value) {
    // A LOCK without a body refreshes a lock identified in the If header (RFC 4918, section 9.10.2).
    const refreshed = refreshLock(target, credentials, timeoutSeconds);
    if (!refreshed)
      return textResponse(
        412,
        "Send the lock token to refresh in an If header, for example If: (<opaquelocktoken:…>).",
      );
    const entry = await entryAt(target);
    return xmlResponse(
      `<d:prop xmlns:d="DAV:">${lockDiscovery([refreshed], entry)}</d:prop>`,
      200,
    );
  }
  const info = body.value;
  if (info.namespace !== DAV || info.local !== "lockinfo")
    return textResponse(400, "A LOCK body must be a DAV:lockinfo element.");
  const scopeElement = child(info, DAV, "lockscope");
  const scope: LockScope | null =
    scopeElement && child(scopeElement, DAV, "shared")
      ? "shared"
      : scopeElement && child(scopeElement, DAV, "exclusive")
        ? "exclusive"
        : null;
  if (!scope)
    return textResponse(
      400,
      "A LOCK body needs <D:lockscope> with <D:exclusive/> or <D:shared/>.",
    );
  const type = child(info, DAV, "locktype");
  if (!type || !child(type, DAV, "write"))
    return textResponse(
      400,
      "Only write locks are supported. Request <D:write/>.",
    );
  const depthHeader = (
    request.headers.get("depth") ?? "infinity"
  ).toLowerCase();
  if (depthHeader !== "0" && depthHeader !== "infinity")
    return textResponse(400, "LOCK supports Depth: 0 or infinity.");
  const depth: LockDepth = depthHeader;
  const ownerElement = child(info, DAV, "owner");
  const owner = ownerElement
    ? ownerElement.children
        .map((node) =>
          typeof node === "string"
            ? escapeXml(node)
            : serializeXml(node, DAV, ownerElement.lang),
        )
        .join("")
    : "";
  // Lock compatibility is decided by lockFile; only creating a file is a write. Holding the
  // target keeps any conflicting change from running between that check and the lock.
  return mutateFiles(
    [],
    credentials,
    async () => {
      (await authenticate(request)).require(target, "write");
      const destination = await safePath(target);
      let entry = await entryOrNull(target);
      let created = false;
      if (!entry) {
        // Locking an unmapped URL creates an empty file (RFC 4918, section 7.3).
        requireMutable(target);
        requireUnlocked([target], credentials);
        await writeFile(destination.absolute, "", { flag: "wx" });
        // History left by a file removed outside Nimbus never attaches to a new one.
        await FileVersions.discard(
          httpDriveStore.versions,
          getDataRoot(),
          destination.relative,
        );
        created = true;
        publishFileEvent({
          path: destination.absolute,
          event: "rename",
          ts: Date.now(),
        });
        entry = await entryAt(target);
      }
      const granted = lockFile(target, credentials, {
        scope,
        depth,
        owner,
        timeoutSeconds,
      });
      return xmlResponse(
        `<d:prop xmlns:d="DAV:">${lockDiscovery([granted], entry)}</d:prop>`,
        created ? 201 : 200,
        { "Lock-Token": `<${granted.token}>` },
      );
    },
    { within: [target] },
  );
}

function matchesETag(header: string, tag: string) {
  return (
    header === "*" || header.split(",").some((value) => value.trim() === tag)
  );
}

async function putFile(
  request: Request,
  requested: string,
  credentials: MutationCredentials,
) {
  const staged = await stageFile(request.body);
  try {
    const mtime = requestedMtime(request);
    // The staged file is private until it commits, so its time can be set outside the lock.
    if (mtime) await setMtime(staged.path, mtime);
    const noneMatch = request.headers.get("if-none-match");
    const match = request.headers.get("if-match");
    const outcome = await commitStagedFile(
      {
        ...credentials,
        versions: httpDriveStore.versions,
        authorize: () => authenticate(request),
      },
      requested,
      staged,
      (current) =>
        !(
          (noneMatch && current && matchesETag(noneMatch, fileTag(current))) ||
          (match && (!current || !matchesETag(match, fileTag(current))))
        ),
    );
    const accepted = mtime ? { "X-OC-Mtime": "accepted" } : undefined;
    switch (outcome.kind) {
      case "created":
        return new Response(null, { status: 201, headers: accepted });
      case "replaced":
        return new Response(null, { status: 204, headers: accepted });
      case "precondition_failed":
        return new Response(null, { status: 412 });
      case "is_directory":
        return textResponse(
          405,
          "This path is a folder. PUT can only write files.",
        );
      case "missing_parent":
        return textResponse(
          409,
          "The parent folder does not exist. Create it first.",
        );
    }
  } finally {
    await staged.discard();
  }
}

async function transfer(
  request: Request,
  method: "MOVE" | "COPY",
  url: URL,
  access: Access,
  target: string,
  credentials: MutationCredentials,
) {
  const destinationHeader = request.headers.get("destination");
  if (!destinationHeader)
    return textResponse(400, "A Destination header is required.");
  let destinationUrl: URL;
  try {
    destinationUrl = new URL(destinationHeader, request.url);
  } catch {
    return textResponse(
      400,
      "The Destination header must contain a valid drive URL.",
    );
  }
  if (destinationUrl.origin !== url.origin)
    return textResponse(502, "The destination must be on this drive.");
  const destination = await safePath(decodedPath(destinationUrl.pathname));
  requireMutable(destination.relative);
  access.require(destination.relative, "write");
  // RFC 4918, section 10.6: Overwrite defaults to T.
  const overwrite = (request.headers.get("overwrite") ?? "T")
    .trim()
    .toUpperCase();
  if (overwrite !== "T" && overwrite !== "F")
    return textResponse(400, "Overwrite must be T or F.");
  const depth = (request.headers.get("depth") ?? "infinity")
    .trim()
    .toLowerCase();
  if (depth !== "infinity" && (method === "MOVE" || depth !== "0"))
    return textResponse(
      400,
      `${method} supports Depth: infinity${method === "COPY" ? " or 0" : ""}.`,
    );
  const options = {
    lockTokens: credentials.lockTokens,
    existing: overwrite === "T" ? ("replace" as const) : ("refuse" as const),
  };
  let replaced: boolean;
  try {
    ({ replaced } =
      method === "COPY"
        ? await copyItem(httpDriveStore, access, target, destination.relative, {
            ...options,
            depth: depth === "0" ? "0" : "infinity",
          })
        : await moveItem(
            httpDriveStore,
            access,
            target,
            destination.relative,
            options,
          ));
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
  const mtime = requestedMtime(request);
  if (mtime) await setMtime(destination.absolute, mtime);
  return new Response(null, {
    status: replaced ? 204 : 201,
    headers: mtime ? { "X-OC-Mtime": "accepted" } : undefined,
  });
}

export async function handleWebDAV(request: Request): Promise<Response> {
  const limited = throttled(request);
  if (limited) return limited;
  try {
    const access = await authenticate(request);
    const url = new URL(request.url);
    const target = (await safePath(decodedPath(url.pathname))).relative;
    const method = request.method;
    if (!allowedMethods.includes(method))
      return new Response(null, {
        status: 405,
        headers: { Allow: allowedMethods.join(", ") },
      });
    if (method === "OPTIONS")
      return new Response(null, {
        status: 200,
        headers: {
          DAV: "1, 2",
          Allow: allowedMethods.join(", "),
          "MS-Author-Via": "DAV",
          "Content-Length": "0",
        },
      });
    if (method === "GET" || method === "HEAD") {
      const entry = await entryAt(target);
      if (entry.type === "file")
        return await serveFile(request, target, access);
      if (!access.canBrowse(target)) throw new TRPCError({ code: "FORBIDDEN" });
      // Clients probe folders with HEAD; browsers get a pointer to the web interface.
      return textResponse(
        200,
        "This is a Nimbus folder. Open it in a WebDAV client or in the Nimbus web interface.",
      );
    }
    if (method === "PROPFIND") return await propfind(request, access, target);
    const conditions = parseIfHeader(request.headers.get("if"));
    if (!conditions.ok) return textResponse(400, conditions.error.message);
    const credentials = {
      userId: access.user.id,
      lockTokens: submittedLockTokens(conditions.value),
    };
    if (method === "UNLOCK") {
      unlockFile(
        target,
        access.user.id,
        request.headers.get("lock-token") ?? "",
      );
      return new Response(null, { status: 204 });
    }
    access.require(target, method === "COPY" ? "read" : "write");
    if (!(await ifHeaderHolds(conditions.value, url, target)))
      return textResponse(
        412,
        "A condition in the If header does not hold. The item was not changed.",
      );
    if (method === "LOCK") return await lock(request, target, credentials);
    if (method === "PROPPATCH")
      return await proppatch(request, target, credentials);
    if (method === "COPY")
      return await transfer(request, method, url, access, target, credentials);
    requireMutable(target);
    if (method === "DELETE") {
      await trashItem(httpDriveStore, access, target, credentials.lockTokens);
      return new Response(null, { status: 204 });
    }
    if (method === "MKCOL") {
      const body = await request.arrayBuffer();
      if (body.byteLength > 0)
        return textResponse(415, "MKCOL does not accept a request body.");
      return await mutateFiles([target], credentials, async () => {
        (await authenticate(request)).require(target, "write");
        const destination = await safePath(target);
        try {
          await mkdir(destination.absolute);
        } catch (error) {
          if (isFsError(error, "EEXIST"))
            return textResponse(405, "An item with this name already exists.");
          throw error;
        }
        publishFileEvent({
          path: destination.absolute,
          event: "rename",
          ts: Date.now(),
        });
        return new Response(null, { status: 201 });
      });
    }
    if (method === "PUT") return await putFile(request, target, credentials);
    if (method === "MOVE")
      return await transfer(request, method, url, access, target, credentials);
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
      return textResponse(
        409,
        "The parent folder does not exist. Create it first.",
      );
    return httpError(error);
  }
}
