import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getAccess } from "@nimbus/api/access";
import { getDataRoot } from "@nimbus/api/data-root";
import type { DriveStore } from "@nimbus/api/drive-store";
import { entryAt, type FileEntry } from "@nimbus/api/file-browser";
import {
  commitStagedFile,
  fileTag,
  stageFile,
  type StagedFile,
} from "@nimbus/api/file-content";
import { fileNameSchema } from "@nimbus/api/file-name";
import { mutateFiles } from "@nimbus/api/file-mutations";
import { lexicalPath, safePath } from "@nimbus/api/file-operations";
import { FilesystemCapacity } from "@nimbus/api/filesystem-capacity";
import { Homes } from "@nimbus/api/homes";
import { McpScope } from "@nimbus/api/mcp-scope";
import { numberedName } from "@nimbus/api/numbered-name";
import { isApiError, isFsError } from "@nimbus/api/safe-path";
import { UploadDestination } from "@nimbus/api/upload-destination";
import { httpError } from "../http-error";
import { ensureFolders } from "../routes/upload-commit";
import { UploadClaims } from "./upload-claims";
import type { Database } from "./oauth/context";
import { liveConnectionUser } from "./oauth/connections";
import { guardTransport } from "./request-guard";
import { UploadLink } from "./upload-link";

/** What the upload route needs from the server. Tests pass a temporary database and drive. */
export type McpUploadContext = {
  db: Database;
  drive: DriveStore;
  secret: string;
  /** When this run of the server started (see ServerRun): links made earlier are refused. */
  startedAt: number;
  /** Origins and hosts the server answers for, as the MCP endpoint checks them. */
  origins: ReadonlySet<string>;
  now: () => number;
  /** Capacity of the filesystem holding `directory`, or null when it cannot be read. */
  capacity: (directory: string) => Promise<FilesystemCapacity | null>;
};

/** How often, in received bytes, a running upload re-reads free space. */
const capacityCheckBytes = 64 * 1024 * 1024;

/** Keys of uploads running now: one link uploads each of its paths once at a time. */
const running = new Set<string>();

/** Uploads one link may run at once, as an agent running curl in parallel would. */
export const MAX_RUNNING_PER_LINK = 16;
/** Uploads running now, by link nonce. */
const runningPerLink = new Map<string, number>();

/**
 * Bytes received by running uploads and not yet committed or discarded. Each upload counts
 * every running upload's bytes against the space spare when it started, so parallel uploads
 * cannot each spend the same free space.
 */
let pendingBytes = 0;

const reply = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, message: string) =>
  reply(status, { error: message });

const newLink = "Call get_upload_link for a new link.";
const noSpace = () =>
  refuse(
    507,
    "The server does not have enough free space for this file. Nothing was saved. Free some space or ask a server administrator to add storage, then upload again.",
  );

type Place =
  | { kind: "place"; path: string; relative: string }
  | { kind: "refused"; status: number; message: string };

/** The drive path a request writes: a file link's own, or one below a folder link's folder. */
function place(destination: UploadDestination, rest: string): Place {
  if (destination.kind === "file")
    return rest === ""
      ? { kind: "place", path: destination.path, relative: "" }
      : {
          kind: "refused",
          status: 404,
          message:
            "This link uploads one file. Nothing was saved. PUT to the link URL itself, with nothing after it.",
        };
  const segments = rest.split("/");
  if (
    rest === "" ||
    !segments.every(
      (segment) =>
        fileNameSchema.safeParse(segment).success && segment === segment.trim(),
    )
  )
    return {
      kind: "refused",
      status: 400,
      message:
        'Add the file\'s path below the folder to the link URL, as <url>/<folder>/<name>. Each part must be a name: not empty, ".", ".." or .nimbus, without control characters or leading or trailing spaces. Nothing was saved.',
    };
  return {
    kind: "place",
    path: [destination.path, rest].filter(Boolean).join("/"),
    relative: rest,
  };
}

async function entryOrNull(relative: string) {
  try {
    return await entryAt(relative);
  } catch (error) {
    if (isApiError(error, "NOT_FOUND")) return null;
    throw error;
  }
}

/** Why a write under `rule` cannot land on `current`, or null when it can. */
function conflict(
  rule: UploadDestination["rule"],
  relative: string,
  current: FileEntry | null,
): { status: number; message: string } | null {
  if (rule.kind === "keep-both") return null;
  if (current?.type === "dir")
    return {
      status: 409,
      message: `${relative} is a folder. Nothing was saved. Upload to a file path inside it.`,
    };
  if (UploadDestination.accepts(rule, current)) return null;
  if (rule.kind === "match")
    return {
      status: 412,
      message:
        current === null
          ? `No file exists at ${relative}, so it does not match expectedEtag. Nothing was saved. ${newLink} Omit expectedEtag to create it.`
          : `${relative} changed since you read it (its etag is now ${fileTag(current)}). Nothing was saved. Read it again, then call get_upload_link with the new etag.`,
    };
  return {
    status: 409,
    message: `${relative} already exists. Nothing was saved. To replace it, call get_upload_link with its etag as expectedEtag or with onConflict "overwrite"; "keep-both" saves the upload under a numbered name.`,
  };
}

/** The nearest existing folder holding `absolute`, a path in the drive: where the file will land. */
async function landingFolder(absolute: string) {
  const root = getDataRoot();
  for (let folder = path.dirname(absolute); ; folder = path.dirname(folder)) {
    if (folder === root || path.dirname(folder) === folder) return root;
    try {
      if ((await stat(folder)).isDirectory()) return folder;
    } catch {
      // Not created yet: the file lands on its nearest existing parent's filesystem.
    }
  }
}

/**
 * Bytes that may still be written on the file's filesystem and the data root's, which holds
 * versions, keeping both floors free.
 */
async function spareBytes(context: McpUploadContext, folder: string) {
  return FilesystemCapacity.spareBytes(
    await Promise.all([
      context.capacity(getDataRoot()),
      context.capacity(folder),
    ]),
    FilesystemCapacity.minimumFreeBytes,
  );
}

/** Why reading a request body stopped early, when it did. */
type BodyFailure =
  | { kind: "none" }
  | { kind: "floor" }
  | { kind: "interrupted" };

/**
 * `body`, read one chunk at a time as staging writes it. It fails once it passes the bytes
 * spare when it started, or when a periodic re-read finds the free-space floor reached (other
 * writers share the disk), and records why it failed, or that the client's body broke off.
 */
function receive(
  body: ReadableStream<Uint8Array>,
  budget: { spare: number; reserved: number } | null,
  reread: () => Promise<number | null>,
) {
  const state: { failure: BodyFailure; received: number } = {
    failure: { kind: "none" },
    received: 0,
  };
  const reader = body.getReader();
  let nextCheck = capacityCheckBytes;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          state.failure = { kind: "interrupted" };
          throw error;
        }
        if (chunk.done) {
          controller.close();
          return;
        }
        state.received += chunk.value.byteLength;
        pendingBytes += chunk.value.byteLength;
        if (budget !== null && state.received >= nextCheck) {
          nextCheck = state.received + capacityCheckBytes;
          const now = await reread();
          if (now !== null && now < 0) state.failure = { kind: "floor" };
        }
        if (budget !== null && pendingBytes + budget.reserved > budget.spare)
          state.failure = { kind: "floor" };
        if (state.failure.kind === "floor") {
          await reader.cancel().catch(() => undefined);
          throw new Error("The upload would pass the free-space floor.");
        }
        controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

/** Whether replacing a file there copies its old content to the data root as a version. */
async function versionNeedsCopy(folder: string) {
  const [root, landing] = await Promise.all([
    stat(getDataRoot()),
    stat(folder),
  ]);
  return root.dev !== landing.dev;
}

const disconnected =
  "The connection that created this link was disconnected, lost the permission to change files, or its account is disabled. Nothing was saved. Reconnect the client, then call get_upload_link again.";

async function upload(
  context: McpUploadContext,
  request: Request,
  link: UploadLink,
  target: { path: string; relative: string },
  key: string,
): Promise<Response> {
  /** The account's current access, refused once the connection or its approval is gone. */
  const authorize = async () => {
    const userId = await liveConnectionUser(
      context.db,
      link.grantId,
      McpScope.write,
    );
    if (userId === null || userId !== link.userId)
      throw new TRPCError({ code: "FORBIDDEN", message: disconnected });
    return getAccess(context.drive, userId);
  };
  const access = await authorize();
  // Before any lookup, so a refusal never tells someone without access what is there.
  const named = lexicalPath(target.path);
  access.require(named.relative, "write");
  await Homes.requireNotReserved(context.drive, named.relative);
  const destination = await safePath(named.relative);
  if (UploadClaims.claimed(context.db, key, context.now()))
    return refuse(
      410,
      `This link already uploaded ${destination.relative}. Nothing was saved this time. ${newLink}`,
    );
  if (running.has(key))
    return refuse(
      409,
      "Another upload of this path with this link is still running. Nothing was saved. Wait for it to finish, or call get_upload_link for a new link.",
    );
  const sameLink = runningPerLink.get(link.nonce) ?? 0;
  if (sameLink >= MAX_RUNNING_PER_LINK)
    return refuse(
      429,
      `This link is already running ${MAX_RUNNING_PER_LINK} uploads. Nothing was saved. Upload at most ${MAX_RUNNING_PER_LINK} files at once, and send this one when another finishes.`,
    );
  running.add(key);
  runningPerLink.set(link.nonce, sameLink + 1);
  try {
    return await receiveAndCommit(
      context,
      request,
      link,
      destination,
      key,
      authorize,
    );
  } finally {
    running.delete(key);
    const left = (runningPerLink.get(link.nonce) ?? 1) - 1;
    if (left > 0) runningPerLink.set(link.nonce, left);
    else runningPerLink.delete(link.nonce);
  }
}

/** Stream the body to staging, within the free-space floor, then commit it. */
async function receiveAndCommit(
  context: McpUploadContext,
  request: Request,
  link: UploadLink,
  destination: { absolute: string; relative: string },
  key: string,
  authorize: () => ReturnType<typeof getAccess>,
): Promise<Response> {
  // Refused before any byte is received when the outcome is already known; checked again at commit.
  const current = await entryOrNull(destination.relative);
  const early = conflict(link.destination.rule, destination.relative, current);
  if (early) return refuse(early.status, early.message);

  const folder = await landingFolder(destination.absolute);
  const spare = await spareBytes(context, folder);
  // A replaced file's content becomes a version: a copy on the data root when it lives elsewhere.
  const reserved =
    current?.type === "file" &&
    (link.destination.rule.kind === "overwrite" ||
      link.destination.rule.kind === "match") &&
    (await versionNeedsCopy(folder))
      ? (current.size ?? 0)
      : 0;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (
    spare !== null &&
    (spare <= 0 ||
      pendingBytes +
        reserved +
        (Number.isSafeInteger(declared) ? declared : 0) >
        spare)
  )
    return noSpace();
  const body =
    request.body &&
    receive(request.body, spare === null ? null : { spare, reserved }, () =>
      spareBytes(context, folder),
    );
  try {
    return await stageAndCommit(
      context,
      request,
      link,
      destination,
      key,
      body,
      authorize,
    );
  } finally {
    if (body) pendingBytes -= body.state.received;
  }
}

async function stageAndCommit(
  context: McpUploadContext,
  request: Request,
  link: UploadLink,
  destination: { absolute: string; relative: string },
  key: string,
  body: ReturnType<typeof receive> | null,
  authorize: () => ReturnType<typeof getAccess>,
): Promise<Response> {
  let staged: StagedFile;
  try {
    // Outside every lock, so a slow transfer never blocks other changes.
    staged = await stageFile(body ? body.stream : null, destination.absolute);
  } catch (error) {
    const failure = body ? body.state.failure : { kind: "none" };
    if (failure.kind === "floor") return noSpace();
    if (failure.kind === "interrupted" || request.signal.aborted)
      return refuse(
        400,
        "The upload stopped before all of its bytes arrived. Nothing was saved. Upload the file again; the link still works until it expires.",
      );
    throw error;
  }
  try {
    return await commit(
      context,
      link,
      destination.relative,
      staged,
      key,
      authorize,
    );
  } finally {
    await staged.discard();
  }
}

/**
 * Commit `staged` at `relative` through the write path WebDAV PUT and the editor use: inside
 * the path's lock, with access re-checked, the previous content kept as a version and a new
 * path claimed. This link's record for the path is claimed inside the same lock, so each path
 * commits once, and released again when nothing was committed.
 */
async function commit(
  context: McpUploadContext,
  link: UploadLink,
  relative: string,
  staged: StagedFile,
  key: string,
  authorize: () => ReturnType<typeof getAccess>,
): Promise<Response> {
  const rule = link.destination.rule;
  let recorded = false;
  let done = false;
  const credentials = {
    userId: link.userId,
    drive: context.drive,
    async authorize() {
      const access = await authorize();
      if (!recorded) {
        if (!UploadClaims.claim(context.db, key, link.expiresAt, context.now()))
          throw new TRPCError({
            code: "CONFLICT",
            message: `This link already uploaded ${relative}. Nothing was saved this time. ${newLink}`,
          });
        recorded = true;
      }
      return access;
    },
  };
  const parent = path.posix.dirname(relative);
  const name = path.posix.basename(relative);
  // Identifies the staged content once renamed into place, to tell whether a failure came after.
  const incoming = await stat(staged.path);
  let candidate = relative;
  let foldersCreated = false;
  try {
    for (let index = 0; ;) {
      candidate = [
        parent === "." ? "" : parent,
        numberedName(name, index, true),
      ]
        .filter(Boolean)
        .join("/");
      const outcome = await commitStagedFile(
        credentials,
        candidate,
        staged,
        (current) => UploadDestination.accepts(rule, current),
      );
      switch (outcome.kind) {
        case "created":
        case "replaced":
          done = true;
          return reply(outcome.kind === "created" ? 201 : 200, {
            outcome: outcome.kind,
            path: outcome.entry.path,
            size: outcome.entry.size,
            etag: fileTag(outcome.entry),
          });
        case "missing_parent":
          if (link.destination.kind === "folder" && !foldersCreated) {
            const base = link.destination.path;
            const below = path.posix.relative(base || ".", parent);
            await mutateFiles(
              [],
              { userId: link.userId },
              async () =>
                ensureFolders(
                  context.drive,
                  await authorize(),
                  base,
                  below === "." ? "" : below,
                  link.userId,
                ),
              { within: [base] },
            );
            foldersCreated = true;
            continue;
          }
          return refuse(
            409,
            "The folder for this file no longer exists. Nothing was saved. Create it with create_folder, then call get_upload_link again.",
          );
        case "is_directory":
        case "precondition_failed": {
          if (rule.kind === "keep-both") {
            index++;
            continue;
          }
          const refusal = conflict(
            rule,
            candidate,
            outcome.kind === "precondition_failed" ? outcome.current : null,
          ) ?? {
            status: 409,
            message: `${candidate} is a folder. Nothing was saved. Upload to a file path inside it.`,
          };
          return refuse(refusal.status, refusal.message);
        }
      }
    }
  } catch (error) {
    // A failure after the content was put in place, such as pruning old versions, leaves the
    // upload committed: its record stays, so the link cannot write the path again.
    if (recorded && !(await holds(candidate, incoming)))
      UploadClaims.release(context.db, key);
    recorded = false;
    throw error;
  } finally {
    if (recorded && !done) UploadClaims.release(context.db, key);
  }
}

/** Whether the drive file at `relative` is the staged file described by `incoming`. */
async function holds(relative: string, incoming: { dev: number; ino: number }) {
  try {
    const now = await lstat(path.join(getDataRoot(), relative));
    return now.dev === incoming.dev && now.ino === incoming.ino;
  } catch {
    return false;
  }
}

/**
 * PUT of a file's raw bytes to a link from the get_upload_link tool. The body streams to
 * staging on the destination's own filesystem, then commits as WebDAV PUT does. Nothing is
 * kept when the upload fails, is refused or the client goes away.
 */
async function handle(
  context: McpUploadContext,
  request: Request,
  params: { token: string; rest: string },
): Promise<Response> {
  const transport = guardTransport(request, context.origins);
  if (!transport.allowed) return refuse(transport.status, transport.message);
  // A query would be cut off the file's name. Upload links never carry one.
  if (/[?#]/.test(request.url))
    return refuse(
      400,
      "The upload URL contains a raw ? or #, which would cut the file's name short. Nothing was saved. Percent-encode them in file names as %3F and %23.",
    );
  const check = UploadLink.verify(context.secret, params.token, {
    now: context.now(),
    startedAt: context.startedAt,
  });
  if (check.kind === "invalid")
    return refuse(
      404,
      `This upload link is not valid. Nothing was saved. ${newLink}`,
    );
  if (check.kind === "restarted")
    return refuse(
      410,
      `This upload link was made before the Nimbus server restarted, so it no longer works. Nothing was saved. ${newLink}`,
    );
  if (check.kind === "expired")
    return refuse(
      410,
      `This upload link has expired: each upload must start before its expiresAt. Nothing was saved. ${newLink}`,
    );
  const { link } = check;
  const target = place(link.destination, params.rest);
  if (target.kind === "refused") return refuse(target.status, target.message);
  try {
    return await upload(
      context,
      request,
      link,
      target,
      UploadLink.commitKey(link, target.relative),
    );
  } catch (error) {
    if (isFsError(error, "ENOSPC") || isFsError(error, "EDQUOT")) {
      console.warn("[mcp] upload failed: the disk is full.");
      return noSpace();
    }
    return httpError(error);
  }
}

export const McpUpload = { handle } as const;
