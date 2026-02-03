import { observable } from "@trpc/server/observable";
import { readdir } from "node:fs/promises";

import { getDataRoot } from "./data-root";

import { subscribeFileEvents, type FileEvent } from "./file-events";
import { protectedProcedure, publicProcedure, router } from "./index";

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
    list: protectedProcedure.query(async () => {
      const root = getDataRoot();
      const entries = await readdir(root, { withFileTypes: true });

      return entries.map((entry) => ({
        name: entry.name,
        path: entry.name,
        type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
      }));
    }),
    onChange: protectedProcedure.subscription(() => {
      return observable<FileEvent>((emit) => {
        const unsubscribe = subscribeFileEvents((event) => {
          emit.next(event);
        });

        return () => {
          unsubscribe();
        };
      });
    }),
  }),
});

export type AppRouter = typeof appRouter;
