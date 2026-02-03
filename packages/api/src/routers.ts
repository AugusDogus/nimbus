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
  files: router({
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
