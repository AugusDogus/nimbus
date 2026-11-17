import { initTRPC, TRPCError } from "@trpc/server";

import { z } from "zod";
import { getAccess } from "./access";

import type { Context } from "./context";

export const t = initTRPC.context<Context>().create();

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  const session = z
    .object({
      user: z.object({ id: z.string().min(1) }),
      session: z.object({ impersonatedBy: z.string().nullish() }).optional(),
    })
    .safeParse(ctx.session);
  if (!session.success) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  return next({
    ctx: {
      ...ctx,
      session: session.data,
      /** The administrator signed in as this user, or null in the user's own session. */
      impersonatedBy: session.data.session?.impersonatedBy ?? null,
      access: await getAccess(ctx.drive, session.data.user.id),
    },
  });
});
