import { TRPCError } from "@trpc/server";
import { getAccess } from "./access";
import { mutateFiles } from "./file-mutations";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { shareModeSchema, type Share } from "./drive-store";
import { requireExisting, safePath } from "./file-operations";
import { protectedProcedure, router } from "./index";
import { auditUser, recordAudit } from "./audit";

const passwordSchema = z.string().min(8).max(128);
const settingsSchema = z.object({
  expiresAt: z.number().int().nullable(),
  maxDownloads: z.number().int().min(1).max(1_000_000).nullable(),
  mode: shareModeSchema,
});
// New links default to unlimited downloads; edits always state every setting.
const createSettingsSchema = settingsSchema.extend({
  maxDownloads: settingsSchema.shape.maxDownloads.default(null),
  mode: shareModeSchema.default("download"),
});

function requireFutureExpiry(expiresAt: number | null) {
  if (expiresAt !== null && expiresAt <= Date.now())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose an expiry date in the future.",
    });
}

const publicShare = ({ passwordHash, ...share }: Share) => ({
  ...share,
  passwordProtected: passwordHash !== null,
});

export const sharesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    (await ctx.drive.listShares(ctx.access.user.id)).map(publicShare),
  ),
  create: protectedProcedure
    .input(
      createSettingsSchema.extend({
        path: z.string(),
        password: passwordSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      ctx.access.require(target.relative, "admin");
      requireFutureExpiry(input.expiresAt);
      const passwordHash = input.password
        ? await Bun.password.hash(input.password)
        : null;
      return mutateFiles([], { userId: ctx.access.user.id }, async () => {
        const access = await getAccess(ctx.drive, ctx.access.user.id);
        access.require(target.relative, "admin");
        await requireExisting(target.relative);
        const token = randomBytes(32).toString("base64url");
        const id = randomUUID();
        await ctx.drive.createShare({
          id,
          token,
          path: target.relative,
          createdBy: access.user.id,
          createdAt: Date.now(),
          expiresAt: input.expiresAt,
          passwordHash,
          downloadCount: 0,
          maxDownloads: input.maxDownloads,
          mode: input.mode,
        });
        recordAudit({
          action: "share.created",
          actor: auditUser(access.user),
          target: { type: "share", id, label: target.relative },
          details: {
            passwordProtected: passwordHash !== null,
            expiresAt: input.expiresAt,
          },
        });
        return { token };
      });
    }),
  update: protectedProcedure
    .input(
      settingsSchema.extend({
        id: z.uuid(),
        password: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("keep") }),
          z.object({ kind: z.literal("set"), value: passwordSchema }),
          z.object({ kind: z.literal("remove") }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireFutureExpiry(input.expiresAt);
      const share = (await ctx.drive.listShares(ctx.access.user.id)).find(
        (candidate) => candidate.id === input.id,
      );
      if (!share)
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "This link was revoked or belongs to someone else. Refresh the list.",
        });
      ctx.access.require(share.path, "admin");
      // A new password changes the unlock signature, so earlier unlocks end.
      const passwordHash =
        input.password.kind === "keep"
          ? share.passwordHash
          : input.password.kind === "set"
            ? await Bun.password.hash(input.password.value)
            : null;
      const updated = await ctx.drive.updateShare(
        share.id,
        ctx.access.user.id,
        {
          expiresAt: input.expiresAt,
          maxDownloads: input.maxDownloads,
          mode: input.mode,
          passwordHash,
        },
      );
      if (!updated)
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            "This link was revoked while you edited it. Its settings were not saved.",
        });
      recordAudit({
        action: "share.updated",
        actor: auditUser(ctx.access.user),
        target: { type: "share", id: updated.id, label: updated.path },
        details: {
          password: input.password.kind,
          expiresAt: updated.expiresAt,
          maxDownloads: updated.maxDownloads,
          mode: updated.mode,
        },
      });
      return publicShare(updated);
    }),
  revoke: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const share = (await ctx.drive.listShares(ctx.access.user.id)).find(
        (entry) => entry.id === input.id,
      );
      if (!share) return;
      await ctx.drive.revokeShare(input.id, ctx.access.user.id);
      recordAudit({
        action: "share.revoked",
        actor: auditUser(ctx.access.user),
        target: { type: "share", id: share.id, label: share.path },
      });
    }),
});
