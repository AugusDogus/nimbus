import { TRPCError, tracked } from "@trpc/server";
import { mkdir, readdir } from "node:fs/promises";
import { readDirectory } from "./file-browser";
import { FileListing } from "./file-listing";
import path from "node:path";
import { z } from "zod";

import { UserPreferences } from "./context";
import { getDataRoot } from "./data-root";
import { statPath } from "./fs-utils";
import { isFsError } from "./safe-path";
import { getAccess } from "./access";
import type { DriveStore, Permission } from "./drive-store";
import { FolderAccess } from "./folder-access";
import { Homes } from "./homes";
import { numberedName } from "./numbered-name";
import { fileNameSchema } from "./file-name";
import { mutateFiles } from "./file-mutations";
import {
  copyItem,
  moveItem,
  lexicalPath,
  NameTakenError,
  requireExisting,
  safePath,
  trashItem,
  undoTransfer,
  type UndoOutcome,
} from "./file-operations";
import {
  managementRouter,
  trashRouter,
  appPasswordsRouter,
} from "./management-router";
import { sharesRouter } from "./shares-router";
import { fileRequestsRouter } from "./file-requests-router";
import { versionsRouter } from "./versions-router";
import { catalogRouter } from "./catalog-router";
import { FilesystemCapacity } from "./filesystem-capacity";
import { driveUsage } from "./search-service";
import { TransferReceipt } from "./transfer-receipt";
import { VacantPath } from "./vacant-path";

import {
  publishFileEvent,
  iterateFileEvents,
  type FileDelta,
  type FileUpdate,
} from "./file-events";
import { createCallerFactory, protectedProcedure, router } from "./index";

const fileEventSchema = z.object({
  path: z.string(),
  event: z.enum(["rename", "change", "delete", "unknown"]),
  ts: z.number(),
});

type EventFacts =
  | { kind: "present"; type: FileDelta["type"] }
  | { kind: "removed" }
  | { kind: "unreadable" };

/**
 * Every live-update subscriber receives the same event object. Facts about it, and the
 * access epoch read after it happened, are computed once per event, not once per subscriber.
 */
const eventFacts = new WeakMap<object, Promise<EventFacts>>();
const eventEpochs = new WeakMap<object, Promise<number>>();

function sharedEpoch(event: unknown, store: DriveStore) {
  if (typeof event !== "object" || event === null) return store.accessEpoch();
  let read = eventEpochs.get(event);
  if (!read) {
    read = store.accessEpoch();
    eventEpochs.set(event, read);
  }
  return read;
}

function sharedFacts(event: unknown, relative: string, absolute: string) {
  const describe = async (): Promise<EventFacts> => {
    try {
      await safePath(relative);
      const stats = await statPath(absolute);
      return {
        kind: "present",
        type: stats.isDirectory ? "dir" : stats.isFile ? "file" : "other",
      };
    } catch (error) {
      return isFsError(error, "ENOENT")
        ? { kind: "removed" }
        : { kind: "unreadable" };
    }
  };
  if (typeof event !== "object" || event === null) return describe();
  let facts = eventFacts.get(event);
  if (!facts) {
    facts = describe();
    eventFacts.set(event, facts);
  }
  return facts;
}

const defaultPreferences: UserPreferences = {
  view: "list",
  sortField: "name",
  sortDirection: "asc",
  groupByType: true,
};

const transferInput = z.object({
  sourcePath: z.string(),
  destinationPath: z.string(),
  /** The name in the destination; the item's own name by default. */
  name: fileNameSchema.optional(),
  /**
   * When the name is taken: `refuse` reports the clash and changes nothing, `keep-both` gives
   * the item the first free numbered name, as "report (1).txt". Nothing is ever replaced.
   */
  clash: z.enum(["refuse", "keep-both"]).optional(),
});

/** What a move or copy of one item did: transferred it, or found its name taken. */
export type TransferOutcome =
  | {
      kind: "transferred";
      name: string;
      path: string;
      receipt: TransferReceipt;
    }
  | { kind: "clash"; name: string };

const joinPath = (folder: string, name: string) =>
  folder ? `${folder}/${name}` : name;

async function requireFolder(relative: string) {
  const folder = await requireExisting(relative);
  if (!folder.stats.isDirectory())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a folder as the destination.",
    });
}

/**
 * Transfer one item into `destination` under `name`, or under the first free numbered name
 * when `clash` is `keep-both`. The move or copy itself checks the name again in its mutation
 * scope, whatever the client saw, so a name taken meanwhile is a clash, never a replacement.
 */
async function transferInto(options: {
  operation: TransferReceipt["operation"];
  actor: string;
  source: string;
  destination: string;
  name: string;
  isFile: boolean;
  clash: "refuse" | "keep-both";
  attempt: (target: string) => Promise<{ path: string; identity: string }>;
}): Promise<TransferOutcome> {
  for (let index = 0; ; index++) {
    const name = numberedName(options.name, index, options.isFile);
    const target = joinPath(options.destination, name);
    try {
      // A copy never lands on its own source: that name is taken by the source itself.
      if (target === options.source) throw new NameTakenError();
      const done = await options.attempt(target);
      return {
        kind: "transferred",
        name: path.posix.basename(done.path),
        path: done.path,
        receipt: TransferReceipt.issue({
          operation: options.operation,
          actor: options.actor,
          from: options.source,
          to: done.path,
          identity: done.identity,
        }),
      };
    } catch (error) {
      if (!(error instanceof NameTakenError)) throw error;
      if (options.clash === "refuse") return { kind: "clash", name };
    }
  }
}

/** Receipts one undo request may carry; clients send more in several requests. */
export const UNDO_BATCH = 500;

/** How often a live event stream re-checks its session while events arrive. */
export const SESSION_RECHECK_MS = 1000;

export const appRouter = router({
  access: managementRouter,
  shares: sharesRouter,
  fileRequests: fileRequestsRouter,
  versions: versionsRouter,
  trash: trashRouter,
  appPasswords: appPasswordsRouter,
  catalog: catalogRouter,
  prefs: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const userId = ctx.access.user.id;
      const stored = await ctx.preferences.getUserPreferences(userId);
      return stored ?? defaultPreferences;
    }),
    set: protectedProcedure
      .input(UserPreferences)
      .mutation(async ({ ctx, input }) => {
        const userId = ctx.access.user.id;
        return ctx.preferences.setUserPreferences(userId, input);
      }),
  }),
  files: router({
    storage: protectedProcedure.query(async ({ ctx }) => {
      ctx.access.requireAdmin();
      const usedBytes = await driveUsage();
      const capacity = await FilesystemCapacity.read(getDataRoot());
      return { usedBytes, capacity };
    }),
    list: protectedProcedure
      .input(
        z.object({
          path: z.string().optional(),
          includeStats: z.boolean().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const { absolute: resolved, relative } = await safePath(
          input.path ?? "",
        );
        if (!ctx.access.canBrowse(relative))
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "You do not have access to this folder. Ask its owner to share it with you.",
          });
        const folderAccess = FolderAccess.of(ctx.access, relative);
        const isFixed = await Homes.protection(ctx.drive);
        const prefix = relative ? `${relative}/` : "";
        const allowed = <T extends { name: string }>(entries: T[]) => {
          const visible: (T & { permission: Permission; fixed: boolean })[] =
            [];
          for (const entry of entries) {
            const permission = folderAccess.permissionOf(entry.name);
            if (permission)
              visible.push({
                ...entry,
                permission,
                fixed: isFixed(prefix + entry.name),
              });
          }
          return visible;
        };

        const directory = await requireExisting(relative);
        if (!directory.stats.isDirectory())
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "This path is not a folder.",
          });
        // Without stats, names and types come from the directory itself.
        if (!input.includeStats)
          return FileListing.encode(
            relative,
            allowed(
              (await readdir(resolved, { withFileTypes: true }))
                .filter(
                  (entry) =>
                    entry.name.toLowerCase() !== ".nimbus" &&
                    (entry.isFile() || entry.isDirectory()),
                )
                .map((entry) => ({
                  name: entry.name,
                  type: entry.isDirectory()
                    ? ("dir" as const)
                    : ("file" as const),
                  mtime: null,
                  size: null,
                })),
            ),
            false,
          );
        return FileListing.encode(
          relative,
          allowed(
            (await readDirectory(relative, ctx.access)).map((entry) => ({
              name: entry.name,
              type: entry.type,
              mtime: entry.mtime,
              size: entry.size,
            })),
          ),
          true,
        );
      }),

    createFolder: protectedProcedure
      .input(z.object({ path: z.string().optional(), name: fileNameSchema }))
      .mutation(async ({ ctx, input }) => {
        const parent = await safePath(input.path ?? "");
        const relative = parent.relative
          ? `${parent.relative}/${input.name}`
          : input.name;
        // Before the lock check, so a WebDAV lock does not reveal an unwritable path exists.
        ctx.access.require(relative, "write");
        return mutateFiles(
          [relative],
          { userId: ctx.access.user.id },
          async () => {
            const access = await getAccess(ctx.drive, ctx.access.user.id);
            access.require(relative, "write");
            const target = await safePath(relative);
            const existing = await requireExisting(parent.relative);
            if (!existing.stats.isDirectory())
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "Choose a folder as the destination.",
              });
            const taken = () =>
              new TRPCError({
                code: "CONFLICT",
                message:
                  "An item with that name already exists. Choose another name.",
              });
            // Records left by content removed outside Nimbus never attach to the folder.
            if ((await VacantPath.claim(ctx.drive, target)).kind === "occupied")
              throw taken();
            try {
              await mkdir(target.absolute);
            } catch (error) {
              if (isFsError(error, "EEXIST")) throw taken();
              throw error;
            }
            publishFileEvent({
              path: target.absolute,
              event: "rename",
              ts: Date.now(),
            });
            return { name: input.name, path: relative };
          },
        );
      }),
    rename: protectedProcedure
      .input(z.object({ path: z.string(), newName: fileNameSchema }))
      .mutation(async ({ ctx, input }) => {
        const source = await safePath(input.path);
        const parent = path.posix.dirname(source.relative);
        return moveItem(
          ctx.drive,
          ctx.access,
          source.relative,
          parent === "." ? input.newName : `${parent}/${input.newName}`,
        );
      }),
    move: protectedProcedure
      .input(transferInput)
      .mutation(async ({ ctx, input }) => {
        const source = await safePath(input.sourcePath);
        const destination = await safePath(input.destinationPath);
        // Before either is looked up, so neither reveals whether it exists.
        ctx.access.require(source.relative, "write");
        ctx.access.require(destination.relative, "write");
        const existing = await requireExisting(source.relative);
        await requireFolder(destination.relative);
        const name = input.name ?? path.posix.basename(source.relative);
        if (joinPath(destination.relative, name) === source.relative)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "This item is already in that folder under that name, so nothing was moved. Choose another folder or name.",
          });
        return transferInto({
          operation: "move",
          actor: ctx.access.user.id,
          source: source.relative,
          destination: destination.relative,
          name,
          isFile: existing.stats.isFile(),
          clash: input.clash ?? "refuse",
          attempt: (target) =>
            moveItem(ctx.drive, ctx.access, source.relative, target),
        });
      }),
    copy: protectedProcedure
      .input(transferInput)
      .mutation(async ({ ctx, input }) => {
        // Read on the source and Write on the destination, as WebDAV COPY requires, checked
        // before either is looked up so neither reveals whether it exists.
        const requested = lexicalPath(input.sourcePath);
        ctx.access.require(requested.relative, "read");
        const into = lexicalPath(input.destinationPath);
        ctx.access.require(into.relative, "write");
        const source = await requireExisting(requested.relative);
        await requireFolder(into.relative);
        // Keep both on a name clash by default, as uploads do. Copying into the item's own
        // folder duplicates it.
        return transferInto({
          operation: "copy",
          actor: ctx.access.user.id,
          source: source.relative,
          destination: into.relative,
          name: input.name ?? path.posix.basename(source.relative),
          isFile: source.stats.isFile(),
          clash: input.clash ?? "keep-both",
          attempt: (target) =>
            copyItem(ctx.drive, ctx.access, source.relative, target),
        });
      }),
    /**
     * Undo moves and copies from their receipts, one after another, each checked again as of
     * now (see `undoTransfer`). Each outcome says what happened to its item.
     */
    undo: protectedProcedure
      .input(
        z.object({
          receipts: z.array(TransferReceipt.schema).min(1).max(UNDO_BATCH),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const outcomes: UndoOutcome[] = [];
        // Last transferred first, so a move into a folder moved in the same batch unwinds in order.
        for (const receipt of [...input.receipts].reverse())
          outcomes.push(await undoTransfer(ctx.drive, ctx.access, receipt));
        return { outcomes: outcomes.reverse() };
      }),
    delete: protectedProcedure
      .input(z.object({ path: z.string() }))
      .mutation(({ ctx, input }) =>
        trashItem(ctx.drive, ctx.access, input.path),
      ),

    onChange: protectedProcedure
      .input(z.object({ path: z.string().optional() }))
      .subscription(async function* ({ ctx, input, signal }) {
        if (!signal) {
          return;
        }
        const root = getDataRoot();
        const hasFilter =
          typeof input.path === "string" && input.path.length > 0;
        const { absolute: requestedAbs, relative: requestedRel } =
          await safePath(input.path ?? "");
        let sessionCheckedAt = Date.now();

        for await (const item of iterateFileEvents(signal)) {
          if (item.kind === "overflow") {
            // Too many changes at once for this client: it reloads instead of replaying them,
            // unless its session ended meanwhile.
            if (Date.now() - sessionCheckedAt >= SESSION_RECHECK_MS) {
              if (!(await ctx.sessionStillValid())) return;
              sessionCheckedAt = Date.now();
            }
            const ts = Date.now();
            const update: FileUpdate = { kind: "resync", ts };
            yield tracked(`${ts}:resync`, update);
            continue;
          }
          const event = item.event;
          const parsed = fileEventSchema.safeParse(event);
          if (!parsed.success) continue;
          const fileEvent = parsed.data;
          const eventAbs = path.isAbsolute(fileEvent.path)
            ? fileEvent.path
            : path.resolve(root, fileEvent.path);
          const eventRel = path.relative(requestedAbs, eventAbs);
          // Path filters first: they cost nothing and drop most events for most subscribers.
          if (
            eventRel === "" ||
            eventRel === "." ||
            eventRel.startsWith("..") ||
            path.isAbsolute(eventRel) ||
            (hasFilter && eventRel.includes(path.sep)) ||
            eventRel.split(path.sep).includes(".nimbus")
          )
            continue;
          // A stream outlives sign-out and revoked sessions unless it checks; the
          // account being disabled ends it through getAccess below.
          if (Date.now() - sessionCheckedAt >= SESSION_RECHECK_MS) {
            if (!(await ctx.sessionStillValid())) return;
            sessionCheckedAt = Date.now();
          }
          const driveRelative = path
            .relative(root, eventAbs)
            .split(path.sep)
            .join("/");
          const access = await getAccess(
            ctx.drive,
            ctx.access.user.id,
            sharedEpoch(event, ctx.drive),
          );
          if (!access.can(driveRelative, "read")) continue;
          const facts = await sharedFacts(event, driveRelative, eventAbs);
          if (facts.kind === "unreadable") continue;
          const entryType: FileDelta["type"] =
            facts.kind === "present" ? facts.type : "other";
          const action: FileDelta["action"] =
            facts.kind === "removed"
              ? "removed"
              : fileEvent.event === "change"
                ? "changed"
                : "added";

          const requestedRelNative = requestedRel.split("/").join(path.sep);
          const normalizedPath = [requestedRelNative, eventRel]
            .filter(Boolean)
            .join(path.sep)
            .split(path.sep)
            .join("/");

          const delta: FileDelta = {
            path: normalizedPath,
            name: path.basename(normalizedPath),
            type: entryType,
            action,
            ts: fileEvent.ts,
          };

          const id = `${delta.ts}:${delta.path}:${delta.action}`;
          const update: FileUpdate = { kind: "delta", ...delta };
          yield tracked(id, update);
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
