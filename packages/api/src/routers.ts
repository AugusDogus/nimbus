import { TRPCError, tracked } from "@trpc/server";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { getDataRoot } from "./data-root";

import { iterateFileEvents, type FileDelta, type FileEvent } from "./file-events";
import { protectedProcedure, publicProcedure, router } from "./index";

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const preferencesSchema = z.object({
  view: z.enum(["list", "grid"]),
  sortField: z.enum(["name", "type", "modified", "size"]),
  sortDirection: z.enum(["asc", "desc"]),
  groupByType: z.boolean(),
});

const getDirectorySize = async (directory: string): Promise<number> => {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  const sizes = await Promise.all(
    entries.map(async (entry) => {
      if (entry.name === ".nimbus" || entry.isSymbolicLink()) {
        return 0;
      }

      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return getDirectorySize(fullPath);
      }

      if (!entry.isFile()) {
        return 0;
      }

      try {
        const stats = await stat(fullPath);
        return stats.size;
      } catch {
        return 0;
      }
    }),
  );

  return sizes.reduce((total, size) => total + size, 0);
};

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
      const root = getDataRoot();
      const usedBytes = await getDirectorySize(root);
      return { usedBytes };
    }),
    list: protectedProcedure
      .input(z.object({ path: z.string().optional(), includeStats: z.boolean().optional() }))
      .query(async ({ input }) => {
        const root = getDataRoot();
        const requested = input.path ? safeDecode(input.path) : "";
        const resolved = path.resolve(root, requested);
        const relative = path.relative(root, resolved);

        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid path.",
          });
        }

        if (relative.split(path.sep).includes(".nimbus")) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Access denied.",
          });
        }

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

        const includeStats = input.includeStats ?? false;
        const results = await Promise.all(
          filtered.map(async (entry) => {
            const entryPath = relative
              ? path.join(relative, entry.name)
              : entry.name;
            const normalizedPath = entryPath.split(path.sep).join("/");
            let mtime: number | null = null;
            let size: number | null = null;

            if (includeStats) {
              const fullPath = path.join(resolved, entry.name);
              try {
                const stats = await stat(fullPath);
                mtime = stats.mtimeMs;
                size = stats.size;
              } catch {
                // Ignore stat errors
              }
            }

            return {
              name: entry.name,
              path: normalizedPath,
              type: entry.isDirectory()
                ? "dir"
                : entry.isFile()
                  ? "file"
                  : "other",
              mtime,
              size,
            };
          }),
        );

        return results;
      }),
    onChange: protectedProcedure
      .input(z.object({ path: z.string().optional() }))
      .subscription(async function* ({ input, signal }) {
        if (!signal) {
          return;
        }
        const root = getDataRoot();
        const requested = input.path ? safeDecode(input.path) : "";
        const requestedAbs = path.resolve(root, requested);
        const requestedRel = path.relative(root, requestedAbs);

        if (requestedRel.startsWith("..") || path.isAbsolute(requestedRel)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid path.",
          });
        }

        for await (const [event] of iterateFileEvents(signal)) {
          const fileEvent = event as FileEvent;
          const eventAbs = path.isAbsolute(fileEvent.path)
            ? fileEvent.path
            : path.resolve(root, fileEvent.path);
          const eventRel = path.relative(requestedAbs, eventAbs);

          if (
            eventRel.startsWith("..") ||
            path.isAbsolute(eventRel) ||
            eventRel.includes(path.sep)
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

          const normalizedPath = [requestedRel, eventRel]
            .filter(Boolean)
            .join(path.sep)
            .split(path.sep)
            .join("/");

          const delta: FileDelta = {
            path: normalizedPath,
            name: eventRel,
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
