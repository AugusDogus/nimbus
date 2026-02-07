import { TRPCError, tracked } from "@trpc/server";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getDataRoot } from "./data-root";
import { getDirEntries, invalidateDirCache, setDirEntries } from "./dir-list-cache";
import { statPath } from "./fs-utils";
import { getListCache, getListCacheKey, setListCache } from "./list-cache";
import { getPermissionsHash } from "./perms-hash";
import { resolveSafePath } from "./safe-path";
import { getForDir, setStats } from "./stats-cache";
import { getStorageUsage } from "./storage-cache";

import { iterateFileEvents, type FileDelta, type FileEvent } from "./file-events";
import { createCallerFactory, protectedProcedure, publicProcedure, router } from "./index";

/** Convert safe-path errors to TRPCErrors. */
function safePath(requested: string) {
  try {
    return resolveSafePath(requested);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "FORBIDDEN") {
      throw new TRPCError({ code: "FORBIDDEN", message: e.message ?? "Access denied." });
    }
    throw new TRPCError({ code: "BAD_REQUEST", message: e.message ?? "Invalid path." });
  }
}

const preferencesSchema = z.object({
  view: z.enum(["list", "grid"]),
  sortField: z.enum(["name", "type", "modified", "size"]),
  sortDirection: z.enum(["asc", "desc"]),
  groupByType: z.boolean(),
});

export const appRouter = router({
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
      const userId = getUserId(ctx.session);
      const stored = await ctx.preferences.getUserPreferences(userId);
      return stored ?? {
        view: "list",
        sortField: "name",
        sortDirection: "asc",
        groupByType: true,
      };
    }),
    set: protectedProcedure
      .input(preferencesSchema)
      .mutation(async ({ ctx, input }) => {
        const userId = getUserId(ctx.session);
        return ctx.preferences.setUserPreferences(userId, input);
      }),
  }),
  files: router({
    storage: protectedProcedure.query(async () => {
      const usedBytes = await getStorageUsage();
      return { usedBytes };
    }),
    list: protectedProcedure
      .input(z.object({ path: z.string().optional(), includeStats: z.boolean().optional() }))
      .query(async ({ ctx, input }) => {
        const { absolute: resolved, relative } = safePath(input.path ?? "");

        const includeStats = input.includeStats ?? false;
        const cachedStats = includeStats ? getForDir(relative) : null;

        let dirMtimeMs: number | null = null;
        try {
          const dirStats = await statPath(resolved);
          dirMtimeMs = dirStats.mtimeMs;
        } catch (error) {
          const cause = error as { code?: string };
          if (cause.code === "ENOENT") {
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
          return memoized;
        }

        let baseEntries = getDirEntries(relative, dirMtimeMs);

        if (!baseEntries) {
          let entries: Dirent[];
          try {
            entries = await readdir(resolved, { withFileTypes: true });
          } catch (error) {
            const cause = error as { code?: string };
            if (cause.code === "ENOENT") {
              throw new TRPCError({
                code: "NOT_FOUND",
                message: "Folder not found.",
              });
            }
            throw error;
          }

          const filtered = entries.filter((entry) => entry.name !== ".nimbus");
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
        return results;
      }),

    createFolder: protectedProcedure
      .input(z.object({ path: z.string().optional(), name: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const parent = safePath(input.path ?? "");
        const folderName = input.name.trim();

        if (folderName.includes("/") || folderName.includes("\\") || folderName === ".." || folderName === ".") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid folder name." });
        }

        const target = path.join(parent.absolute, folderName);
        try {
          await mkdir(target);
        } catch (error) {
          const cause = error as { code?: string };
          if (cause.code === "EEXIST") {
            throw new TRPCError({ code: "CONFLICT", message: "A folder with that name already exists." });
          }
          throw error;
        }

        invalidateDirCache(parent.absolute);
        return { name: folderName, path: parent.relative ? `${parent.relative}/${folderName}` : folderName };
      }),

    rename: protectedProcedure
      .input(z.object({ path: z.string(), newName: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const source = safePath(input.path);
        const newName = input.newName.trim();

        if (newName.includes("/") || newName.includes("\\") || newName === ".." || newName === ".") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid name." });
        }

        const parentDir = path.dirname(source.absolute);
        const target = path.join(parentDir, newName);

        try {
          await statPath(source.absolute);
        } catch {
          throw new TRPCError({ code: "NOT_FOUND", message: "File or folder not found." });
        }

        try {
          await statPath(target);
          throw new TRPCError({ code: "CONFLICT", message: "An item with that name already exists." });
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          // ENOENT means target doesn't exist — that's what we want
        }

        await rename(source.absolute, target);
        invalidateDirCache(source.absolute);
        invalidateDirCache(target);

        const parentRelative = source.relative.includes("/")
          ? source.relative.substring(0, source.relative.lastIndexOf("/"))
          : "";
        return { name: newName, path: parentRelative ? `${parentRelative}/${newName}` : newName };
      }),

    move: protectedProcedure
      .input(z.object({ sourcePath: z.string(), destinationPath: z.string() }))
      .mutation(async ({ input }) => {
        const source = safePath(input.sourcePath);
        const dest = safePath(input.destinationPath);

        try {
          await statPath(source.absolute);
        } catch {
          throw new TRPCError({ code: "NOT_FOUND", message: "Source not found." });
        }

        // Destination should be a directory
        try {
          const destStat = await statPath(dest.absolute);
          if (!destStat.isDirectory) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "Destination is not a folder." });
          }
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new TRPCError({ code: "NOT_FOUND", message: "Destination folder not found." });
        }

        const fileName = path.basename(source.absolute);
        const target = path.join(dest.absolute, fileName);

        try {
          await statPath(target);
          throw new TRPCError({ code: "CONFLICT", message: "An item with that name already exists in the destination." });
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          // ENOENT — good
        }

        await rename(source.absolute, target);
        invalidateDirCache(source.absolute);
        invalidateDirCache(dest.absolute);
        return { name: fileName, path: dest.relative ? `${dest.relative}/${fileName}` : fileName };
      }),

    delete: protectedProcedure
      .input(z.object({ path: z.string() }))
      .mutation(async ({ input }) => {
        const target = safePath(input.path);

        try {
          await stat(target.absolute);
        } catch {
          throw new TRPCError({ code: "NOT_FOUND", message: "File or folder not found." });
        }

        await rm(target.absolute, { recursive: true });
        invalidateDirCache(target.absolute);
        return { path: target.relative };
      }),

    onChange: protectedProcedure
      .input(z.object({ path: z.string().optional() }))
      .subscription(async function* ({ input, signal }) {
        if (!signal) {
          return;
        }
        const root = getDataRoot();
        const hasFilter = typeof input.path === "string" && input.path.length > 0;
        const { absolute: requestedAbs, relative: requestedRel } = safePath(input.path ?? "");

        for await (const [event] of iterateFileEvents(signal)) {
          const fileEvent = event as FileEvent;
          const eventAbs = path.isAbsolute(fileEvent.path)
            ? fileEvent.path
            : path.resolve(root, fileEvent.path);
          const eventRel = path.relative(requestedAbs, eventAbs);

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
            const stats = await stat(eventAbs);
            entryType = stats.isDirectory()
              ? "dir"
              : stats.isFile()
                ? "file"
                : "other";
            action = fileEvent.event === "change" ? "changed" : "added";
          } catch (error) {
            const cause = error as { code?: string };
            if (cause.code === "ENOENT") {
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

const getUserId = (session: unknown) => {
  if (!session || typeof session !== "object") {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== "object") {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const id = (user as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return id;
};

export const createCaller = createCallerFactory(appRouter);
