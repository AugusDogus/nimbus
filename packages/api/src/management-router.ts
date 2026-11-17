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
import { auditUser, recordAudit } from "./audit";
import { emptyTrash } from "./trash-empty";

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
      return mutateFiles(
        [],
        { userId: ctx.access.user.id },
        async () => {
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
          const id = randomUUID();
          await ctx.drive.saveGrant({
            id,
            path: target.relative,
            subject: input.subject,
            permission: input.permission,
          });
          recordAudit({
            action: "grant.added",
            actor: auditUser(access.user),
            target: { type: "path", id: target.relative },
            details: {
              subjectType: input.subject.type,
              subjectId: input.subject.id,
              permission: input.permission,
            },
          });
        },
        // Hold the item so it cannot move or go to trash while its sharing record is created.
        { within: [target.relative] },
      );
    }),
  revoke: protectedProcedure
    .input(z.object({ path: z.string(), id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      ctx.access.require(target.relative, "admin");
      const grants = await ctx.drive.grantsForPath(target.relative);
      const grant = grants.find((entry) => entry.id === input.id);
      if (!grant) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.drive.removeGrant(input.id);
      recordAudit({
        action: "grant.removed",
        actor: auditUser(ctx.access.user),
        target: { type: "path", id: target.relative },
        details: {
          subjectType: grant.subject.type,
          subjectId: grant.subject.id,
          permission: grant.permission,
        },
      });
    }),
  shared: protectedProcedure.query(({ ctx }) => ctx.access.grants),
  /**
   * Groups to share with. Who belongs to a group is shown to server administrators only;
   * everyone else gets each group's id and name, with an empty member list.
   */
  groups: protectedProcedure.query(async ({ ctx }) => {
    const groups = await ctx.drive.listGroups();
    return ctx.access.isAdmin
      ? groups
      : groups.map(({ id, name }) => ({ id, name, memberIds: [] }));
  }),
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
      const group = {
        id: input.id ?? randomUUID(),
        name: input.name,
        memberIds: [...new Set(input.memberIds)],
      };
      await ctx.drive.saveGroup(group);
      recordAudit({
        action: "group.saved",
        actor: auditUser(ctx.access.user),
        target: { type: "group", id: group.id, label: group.name },
        details: {
          created: input.id === undefined,
          members: group.memberIds.join(","),
        },
      });
    }),
  removeGroup: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      ctx.access.requireAdmin();
      const group = (await ctx.drive.listGroups()).find(
        (entry) => entry.id === input.id,
      );
      await ctx.drive.removeGroup(input.id);
      if (group)
        recordAudit({
          action: "group.removed",
          actor: auditUser(ctx.access.user),
          target: { type: "group", id: group.id, label: group.name },
        });
    }),
});

export const trashRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    ctx.drive.listTrash(ctx.access.isAdmin ? null : ctx.access.user.id),
  ),
  restore: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => restoreItem(ctx.drive, ctx.access, input.id)),
  purge: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await getOwnedTrash(ctx.drive, ctx.access, input.id);
      await purgeItem(ctx.drive, ctx.access, input.id);
    }),
  /** Deletes the items listed, as shown when the caller confirmed. */
  empty: protectedProcedure
    // The client sends a large trash in batches of this size.
    .input(z.object({ ids: z.array(z.uuid()).max(5_000) }))
    .mutation(({ ctx, input }) => emptyTrash(ctx.drive, ctx.access, input.ids)),
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
      if (ctx.impersonatedBy !== null)
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "An administrator signed in as this person cannot create app passwords for them. Stop impersonating, or ask them to create it. No password was created.",
        });
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      await ctx.drive.addAppPassword({
        id,
        userId: ctx.access.user.id,
        name: input.name,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        createdAt: Date.now(),
      });
      recordAudit({
        action: "app_password.created",
        actor: auditUser(ctx.access.user),
        target: { type: "app_password", id, label: input.name },
      });
      return { token };
    }),
  revoke: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const password = (
        await ctx.drive.listAppPasswords(ctx.access.user.id)
      ).find((entry) => entry.id === input.id);
      if (!password) return;
      await ctx.drive.removeAppPassword(input.id, ctx.access.user.id);
      recordAudit({
        action: "app_password.revoked",
        actor: auditUser(ctx.access.user),
        target: { type: "app_password", id: password.id, label: password.name },
      });
    }),
});
