import { initTRPC, TRPCError } from "@trpc/server";

import { z } from "zod";
import { getAccess } from "./access";
import { FilesystemFailure } from "./filesystem-failure";

import type { Context } from "./context";

export const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    // Unexpected errors carry the thrown message, which can name host paths or SQL. The
    // server logs the original; the client gets a message it can act on.
    if (error.code !== "INTERNAL_SERVER_ERROR") return shape;
    return {
      ...shape,
      message:
        "Nimbus could not complete this request because of an unexpected server error. The item may or may not have changed; refresh to check it before trying again. If this continues, ask a server administrator to check the Nimbus server logs.",
      data: { ...shape.data, stack: undefined },
    };
  },
});

/** Expected filesystem failures become typed errors instead of internal ones; see FilesystemFailure. */
const filesystemFailures = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.code === "INTERNAL_SERVER_ERROR") {
    const mapped = FilesystemFailure.toApiError(result.error.cause);
    if (mapped) throw mapped;
  }
  return result;
});

export const createCallerFactory = t.createCallerFactory;
export const router = t.router;
export const publicProcedure = t.procedure.use(filesystemFailures);
export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
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
