import { TRPCError } from "@trpc/server";
import { getAccess } from "./access";
import { mutateFiles } from "./file-mutations";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { requireExisting, safePath } from "./file-operations";
import { protectedProcedure, router } from "./index";

export const sharesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    (await ctx.drive.listShares(ctx.access.user.id)).map(
      ({ passwordHash, ...share }) => ({
        ...share,
        passwordProtected: passwordHash !== null,
      }),
    ),
  ),
  create: protectedProcedure
    .input(
      z.object({
        path: z.string(),
        expiresAt: z.number().int().nullable(),
        password: z.string().min(8).max(128).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      ctx.access.require(target.relative, "admin");
      const passwordHash = input.password
        ? await Bun.password.hash(input.password)
        : null;
      return mutateFiles([], { userId: ctx.access.user.id }, async () => {
        const access = await getAccess(ctx.drive, ctx.access.user.id);
        access.require(target.relative, "admin");
        await requireExisting(target.relative);
        if (input.expiresAt !== null && input.expiresAt <= Date.now())
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose an expiry date in the future.",
          });
        const token = randomBytes(32).toString("base64url");
        await ctx.drive.createShare({
          id: randomUUID(),
          token,
          path: target.relative,
          createdBy: access.user.id,
          createdAt: Date.now(),
          expiresAt: input.expiresAt,
          passwordHash,
          downloadCount: 0,
        });
        return { token };
      });
    }),
  revoke: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.drive.revokeShare(input.id, ctx.access.user.id),
    ),
});
