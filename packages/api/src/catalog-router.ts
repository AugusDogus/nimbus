import { permissionFor } from "./access";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { entryAt } from "./file-browser";
import type { Bookmark } from "./drive-store";
import type { HistoryEntry } from "./search-index";
import { searchEntries } from "./search-service";
import { safePath } from "./file-operations";
import { isApiError } from "./safe-path";
import { protectedProcedure, router } from "./index";

/** Opens that count toward ranking: the most recent ones, and every starred one. */
const HISTORY_LIMIT = 500;

/** The caller's bookmarks as search history, newest first. */
function searchHistory(bookmarks: readonly Bookmark[]): HistoryEntry[] {
  return [...bookmarks]
    .sort(
      (a, b) =>
        Number(b.starred) - Number(a.starred) || b.accessedAt - a.accessedAt,
    )
    .slice(0, HISTORY_LIMIT)
    .map((bookmark) => ({
      path: bookmark.path,
      openedAt: bookmark.accessedAt,
      visits: bookmark.visits,
      starred: bookmark.starred,
    }));
}

export const catalogRouter = router({
  shared: protectedProcedure.query(async ({ ctx }) => {
    const entries = [];
    for (const path of new Set(ctx.access.grants.map((grant) => grant.path))) {
      try {
        entries.push({
          ...(await entryAt(path)),
          permission: permissionFor(ctx.access, path),
        });
      } catch (error) {
        if (!isApiError(error, "NOT_FOUND")) throw error;
      }
    }
    return entries;
  }),
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().trim().min(1).max(200),
        path: z.string().default(""),
        limit: z.number().int().min(1).max(200).default(50),
        /** "instant" for names only while typing; "full" adds the words layer and paging. */
        depth: z.enum(["instant", "full"]).default("full"),
        /** `next` from the previous page. */
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input, signal }) => {
      const target = await safePath(input.path);
      const result = await searchEntries(
        ctx.access,
        target.relative,
        input.query,
        input.limit,
        {
          depth: input.depth,
          offset: input.offset,
          history: searchHistory(
            await ctx.drive.listBookmarks(ctx.access.user.id),
          ),
          signal,
        },
      );
      return {
        ...result,
        entries: result.entries.map((entry) => ({
          ...entry,
          permission: permissionFor(ctx.access, entry.path),
        })),
      };
    }),
  bookmarks: protectedProcedure.query(async ({ ctx }) => {
    const results = [];
    for (const bookmark of await ctx.drive.listBookmarks(ctx.access.user.id)) {
      if (!ctx.access.canBrowse(bookmark.path)) continue;
      try {
        results.push({
          ...(await entryAt(bookmark.path)),
          permission: permissionFor(ctx.access, bookmark.path),
          starred: bookmark.starred,
          accessedAt: bookmark.accessedAt,
        });
      } catch (error) {
        if (!isApiError(error, "NOT_FOUND")) throw error;
      }
    }
    return results.sort((a, b) => b.accessedAt - a.accessedAt);
  }),
  bookmark: protectedProcedure
    .input(z.object({ path: z.string(), starred: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      if (!ctx.access.canBrowse(target.relative))
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "This folder is not shared with you.",
        });
      await entryAt(target.relative);
      const existing = (await ctx.drive.listBookmarks(ctx.access.user.id)).find(
        (item) => item.path === target.relative,
      );
      await ctx.drive.saveBookmark(ctx.access.user.id, {
        path: target.relative,
        starred: input.starred ?? existing?.starred ?? false,
        accessedAt: Date.now(),
        // Starring is not an open; every other call records one.
        visits: (existing?.visits ?? 0) + (input.starred === undefined ? 1 : 0),
      });
    }),
});
