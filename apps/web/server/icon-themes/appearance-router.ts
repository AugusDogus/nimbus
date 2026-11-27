import { protectedProcedure, router } from "@nimbus/api";
import { IconThemeLibrary } from "./icon-theme-library";

/** The signed-in account's appearance: its file icon set. */
export const appearanceRouter = router({
  icons: protectedProcedure.query(({ ctx }) =>
    IconThemeLibrary.current(ctx.access.user.id),
  ),
});
