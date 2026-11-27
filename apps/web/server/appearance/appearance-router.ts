import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "@nimbus/api";
import { allowedOrigins } from "@/lib/auth";
import { ThemePreferences } from "@/lib/theme-preferences";
import { db } from "../db";
import { RequestOrigin } from "../request-origin";
import { ColorThemes, themeChangeSchema } from "./color-themes";
import { IconThemeImport } from "../icon-themes/icon-theme-import";
import {
  IconThemeLibrary,
  type LibraryResult,
} from "../icon-themes/icon-theme-library";
import { OpenVsxClient } from "../icon-themes/open-vsx-client";

/** Changes must come from Nimbus's own pages, as for other cookie-authenticated writes. */
const fromNimbusPage = protectedProcedure.use(({ ctx, next }) => {
  if (!RequestOrigin.fromNimbus(ctx, allowedOrigins))
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "This request did not come from a Nimbus page. Nothing was changed.",
    });
  return next();
});

const unwrap = <T>(result: LibraryResult<T>): T => {
  if (result.ok) return result.value;
  throw new TRPCError({ code: "BAD_REQUEST", message: result.error });
};

const themeId = z.string().min(1).max(100);
const extensionPart = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w.-]+$/);

/** The signed-in account's appearance: its file icon set and its color themes. */
export const appearanceRouter = router({
  icons: protectedProcedure.query(({ ctx }) =>
    IconThemeLibrary.current(ctx.access.user.id),
  ),
  iconSets: protectedProcedure.query(({ ctx }) =>
    IconThemeLibrary.list(ctx.access.user.id),
  ),
  chooseIcons: fromNimbusPage
    .input(z.object({ id: themeId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await IconThemeLibrary.choose(ctx.access.user.id, input.id)),
    ),
  /**
   * Open VSX extensions that contribute file icon themes. The server asks Open VSX, so only
   * Nimbus's own pages may make it.
   */
  searchIconSets: fromNimbusPage
    .input(z.object({ query: z.string().trim().min(1).max(200) }))
    .query(async ({ input, signal }) =>
      unwrap(await OpenVsxClient.search(input.query, signal)),
    ),
  importIconSets: fromNimbusPage
    .input(z.object({ namespace: extensionPart, name: extensionPart }))
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await IconThemeImport.importExtension(
          ctx.access.user.id,
          input.namespace,
          input.name,
        ),
      ),
    ),
  removeIconSet: fromNimbusPage
    .input(z.object({ id: themeId }))
    .mutation(async ({ ctx, input }) =>
      unwrap(await IconThemeLibrary.remove(ctx.access.user.id, input.id)),
    ),
  /** The account's color themes, or null before any browser synced them. */
  colorThemes: protectedProcedure.query(({ ctx }) =>
    ColorThemes.get(db, ctx.access.user.id),
  ),
  changeColorThemes: fromNimbusPage
    .input(themeChangeSchema)
    .mutation(({ ctx, input }) => {
      const result = ColorThemes.change(db, ctx.access.user.id, input);
      if (result.ok) return result.value;
      throw new TRPCError({ code: "BAD_REQUEST", message: result.error });
    }),
  /** Brings the themes a browser saved before they synced into the account, once. */
  migrateColorThemes: fromNimbusPage
    .input(ThemePreferences.schema)
    .mutation(({ ctx, input }) =>
      ColorThemes.migrate(db, ctx.access.user.id, input),
    ),
});
