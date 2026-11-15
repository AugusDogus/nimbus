import { TRPCError } from "@trpc/server";
import { getAccess } from "./access";
import { mutateFiles } from "./file-mutations";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { permissionSchema, subjectSchema } from "./drive-store";
import {
  getOwnedTrash,
  purgeItem,
  requireExisting,
  restoreItem,
  safePath,
} from "./file-operations";
import { protectedProcedure, router } from "./index";

export const managementRouter = router({
  capabilities: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      return {
        canWrite: ctx.access.can(target.relative, "write"),
        canShare: ctx.access.can(target.relative, "admin"),
        isAdmin: ctx.access.isAdmin,
      };
    }),
  me: protectedProcedure.query(async ({ ctx }) => ({
    ...ctx.access.user,
    isAdmin: ctx.access.isAdmin,
    home: await ctx.drive.homeOf(ctx.access.user.id),
  })),
  people: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      // The account directory is visible only to people who can share this path.
      const target = await safePath(input.path);
      ctx.access.require(target.relative, "admin");
      const users = await ctx.drive.listUsers();
      return users
        .filter((user) => !user.banned)
        .map(({ id, name, email }) => ({ id, name, email }));
    }),
  permissions: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      ctx.access.require(target.relative, "admin");
      return ctx.drive.grantsForPath(target.relative);
    }),
  grant: protectedProcedure
    .input(
      z.object({
        path: z.string(),
        subject: subjectSchema,
        permission: permissionSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      return mutateFiles([], { userId: ctx.access.user.id }, async () => {
        const access = await getAccess(ctx.drive, ctx.access.user.id);
        access.require(target.relative, "admin");
        await requireExisting(target.relative);
        const exists =
          input.subject.type === "user"
            ? await ctx.drive.getUser(input.subject.id)
            : (await ctx.drive.listGroups()).some(
                (group) => group.id === input.subject.id,
              );
        if (!exists)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "The selected user or group no longer exists.",
          });
        await ctx.drive.saveGrant({
          id: randomUUID(),
          path: target.relative,
          subject: input.subject,
          permission: input.permission,
        });
      });
    }),
  revoke: protectedProcedure
    .input(z.object({ path: z.string(), id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      ctx.access.require(target.relative, "admin");
      const grants = await ctx.drive.grantsForPath(target.relative);
      if (!grants.some((grant) => grant.id === input.id))
        throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.drive.removeGrant(input.id);
    }),
  shared: protectedProcedure.query(({ ctx }) => ctx.access.grants),
  groups: protectedProcedure.query(({ ctx }) => ctx.drive.listGroups()),
  saveGroup: protectedProcedure
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string().trim().min(1).max(100),
        memberIds: z.array(z.string()).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      ctx.access.requireAdmin();
      const users = await ctx.drive.listUsers();
      if (input.memberIds.some((id) => !users.some((user) => user.id === id)))
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A selected group member no longer exists.",
        });
      const groups = await ctx.drive.listGroups();
      if (
        groups.some(
          (group) => group.name === input.name && group.id !== input.id,
        )
      )
        throw new TRPCError({
          code: "CONFLICT",
          message: "A group with that name already exists.",
        });
      await ctx.drive.saveGroup({
        id: input.id ?? randomUUID(),
        name: input.name,
        memberIds: [...new Set(input.memberIds)],
      });
    }),
  removeGroup: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      ctx.access.requireAdmin();
      await ctx.drive.removeGroup(input.id);
    }),
});

export const trashRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.drive.listTrash(ctx.access.isAdmin ? null : ctx.access.user.id),
  ),
  restore: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => restoreItem(ctx.drive, ctx.access, input.id)),
  purge: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await getOwnedTrash(ctx.drive, ctx.access, input.id);
      await purgeItem(ctx.drive, ctx.access, input.id);
    }),
});

export const appPasswordsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    (await ctx.drive.listAppPasswords(ctx.access.user.id)).map(
      ({ id, name, createdAt }) => ({ id, name, createdAt }),
    ),
  ),
  create: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const token = randomBytes(32).toString("base64url");
      await ctx.drive.addAppPassword({
        id: randomUUID(),
        userId: ctx.access.user.id,
        name: input.name,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        createdAt: Date.now(),
      });
      return { token };
    }),
  revoke: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.drive.removeAppPassword(input.id, ctx.access.user.id),
    ),
});
