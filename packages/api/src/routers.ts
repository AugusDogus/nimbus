import { TRPCError, tracked } from "@trpc/server";
import type { Dirent } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { UserPreferences } from "./context";
import { getDataRoot } from "./data-root";
import { getDirEntries, setDirEntries } from "./dir-list-cache";
import { statPath } from "./fs-utils";
import { getListCache, getListCacheKey, setListCache } from "./list-cache";
import { getPermissionsHash } from "./perms-hash";
import { isFsError } from "./safe-path";
import { getAccess, permissionFor } from "./access";
import { fileNameSchema } from "./file-name";
import { mutateFiles } from "./file-mutations";
import {
  moveItem,
  requireExisting,
  safePath,
  trashItem,
} from "./file-operations";
import {
  managementRouter,
  trashRouter,
  appPasswordsRouter,
} from "./management-router";
import { sharesRouter } from "./shares-router";
import { catalogRouter } from "./catalog-router";
import { getForDir, setStats } from "./stats-cache";
import { getStorageUsage } from "./storage-cache";
import { FilesystemCapacity } from "./filesystem-capacity";

import {
  publishFileEvent,
  iterateFileEvents,
  type FileDelta,
} from "./file-events";
import {
  createCallerFactory,
  protectedProcedure,
  publicProcedure,
  router,
} from "./index";

const fileEventSchema = z.object({
  path: z.string(),
  event: z.enum(["rename", "change", "delete", "unknown"]),
  ts: z.number(),
});

const preferencesSchema = z.object({
  view: z.enum(["list", "grid"]),
  sortField: z.enum(["name", "type", "modified", "size"]),
  sortDirection: z.enum(["asc", "desc"]),
  groupByType: z.boolean(),
});

const defaultPreferences: UserPreferences = {
  view: "list",
  sortField: "name",
  sortDirection: "asc",
  groupByType: true,
};

export const appRouter = router({
  access: managementRouter,
  shares: sharesRouter,
  trash: trashRouter,
  appPasswords: appPasswordsRouter,
  catalog: catalogRouter,
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  privateData: protectedProcedure.query(({ ctx }) => {
    return {
      message: "Authenticated",
      session: ctx.session,
    };
  }),
  prefs: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const userId = ctx.access.user.id;
      const stored = await ctx.preferences.getUserPreferences(userId);
      return stored ?? defaultPreferences;
    }),
    set: protectedProcedure
      .input(preferencesSchema)
      .mutation(async ({ ctx, input }) => {
        const userId = ctx.access.user.id;
        return ctx.preferences.setUserPreferences(userId, input);
      }),
  }),
  files: router({
    storage: protectedProcedure.query(async ({ ctx }) => {
      ctx.access.requireAdmin();
      const usedBytes = await getStorageUsage();
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
        const allowed = <T extends { path: string }>(entries: T[]) =>
          entries
            .filter((entry) => ctx.access.canBrowse(entry.path))
            .map((entry) => ({
              ...entry,
              permission: permissionFor(ctx.access, entry.path),
            }));

        const includeStats = input.includeStats ?? false;
        const cachedStats = includeStats ? getForDir(relative) : null;

        let dirMtimeMs: number | null = null;
        try {
          const dirStats = await statPath(resolved);
          if (!dirStats.isDirectory)
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "This path is not a folder.",
            });
          dirMtimeMs = dirStats.mtimeMs;
        } catch (error) {
          if (isFsError(error, "ENOENT")) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Folder not found.",
            });
          }
          throw error;
        }

        const permsHash = getPermissionsHash(ctx.session);
        const listCacheKey = getListCacheKey({
          relativePath: relative,
          includeStats,
          dirMtimeMs,
          permsHash,
        });
        const memoized = getListCache(listCacheKey);
        if (memoized) {
          return allowed(memoized);
        }

        let baseEntries = getDirEntries(relative, dirMtimeMs);

        if (!baseEntries) {
          let entries: Dirent[];
          try {
            entries = await readdir(resolved, { withFileTypes: true });
          } catch (error) {
            if (isFsError(error, "ENOENT")) {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: "Folder not found.",
              });
            }
            throw error;
          }

          const filtered = entries.filter(
            (entry) =>
              entry.name.toLowerCase() !== ".nimbus" &&
              (entry.isFile() || entry.isDirectory()),
          );
          baseEntries = filtered.map((entry) => {
            const entryPath = relative
              ? [relative, entry.name].join("/")
              : entry.name;
            return {
              name: entry.name,
              path: entryPath,
              type: entry.isDirectory()
                ? "dir"
                : entry.isFile()
                  ? "file"
                  : "other",
            };
          });
          setDirEntries(relative, baseEntries, dirMtimeMs);
        }

        const results = await Promise.all(
          baseEntries.map(async (entry) => {
            let mtime: number | null = null;
            let size: number | null = null;

            if (includeStats) {
              const cached = cachedStats?.get(entry.name);
              if (cached) {
                mtime = cached.mtime;
                size = cached.size;
              } else {
                const fullPath = path.join(resolved, entry.name);
                try {
                  const stats = await statPath(fullPath);
                  mtime = stats.mtimeMs;
                  size = stats.size;
                  setStats(entry.path, { size, mtime });
                } catch {
                  // Ignore stat errors
                }
              }
            }

            return {
              name: entry.name,
              path: entry.path,
              type: entry.type,
              mtime,
              size,
            };
          }),
        );

        setListCache(listCacheKey, results);
        return allowed(results);
      }),

    createFolder: protectedProcedure
      .input(z.object({ path: z.string().optional(), name: fileNameSchema }))
      .mutation(async ({ ctx, input }) => {
        const parent = await safePath(input.path ?? "");
        const relative = parent.relative
          ? `${parent.relative}/${input.name}`
          : input.name;
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
            try {
              await mkdir(target.absolute);
            } catch (error) {
              if (isFsError(error, "EEXIST"))
                throw new TRPCError({
                  code: "CONFLICT",
                  message:
                    "An item with that name already exists. Choose another name.",
                });
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
      .input(z.object({ sourcePath: z.string(), destinationPath: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const source = await safePath(input.sourcePath);
        const destination = await safePath(input.destinationPath);
        ctx.access.require(destination.relative, "write");
        const dest = await requireExisting(destination.relative);
        if (!dest.stats.isDirectory())
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose a folder as the destination.",
          });
        return moveItem(
          ctx.drive,
          ctx.access,
          source.relative,
          [destination.relative, path.basename(source.relative)]
            .filter(Boolean)
            .join("/"),
        );
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

        for await (const [event] of iterateFileEvents(signal)) {
          const parsed = fileEventSchema.safeParse(event);
          if (!parsed.success) continue;
          const fileEvent = parsed.data;
          const eventAbs = path.isAbsolute(fileEvent.path)
            ? fileEvent.path
            : path.resolve(root, fileEvent.path);
          const eventRel = path.relative(requestedAbs, eventAbs);
          const driveRelative = path
            .relative(root, eventAbs)
            .split(path.sep)
            .join("/");
          const access = await getAccess(ctx.drive, ctx.access.user.id);
          if (!access.can(driveRelative, "read")) continue;

          if (
            eventRel.startsWith("..") ||
            path.isAbsolute(eventRel) ||
            (hasFilter && eventRel.includes(path.sep))
          ) {
            continue;
          }

          if (eventRel === "" || eventRel === ".") {
            continue;
          }

          if (eventRel.split(path.sep).includes(".nimbus")) {
            continue;
          }

          let entryType: FileDelta["type"] = "other";
          let action: FileDelta["action"] = "changed";

          try {
            await safePath(driveRelative);
            const stats = await statPath(eventAbs);
            entryType = stats.isDirectory
              ? "dir"
              : stats.isFile
                ? "file"
                : "other";
            action = fileEvent.event === "change" ? "changed" : "added";
          } catch (error) {
            if (isFsError(error, "ENOENT")) {
              action = "removed";
            } else {
              continue;
            }
          }

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

          yield tracked(id, delta);
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;

export const createCaller = createCallerFactory(appRouter);
