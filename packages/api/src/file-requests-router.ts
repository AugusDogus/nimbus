import { TRPCError } from "@trpc/server";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { getAccess } from "./access";
import { auditUser, recordAudit } from "./audit";
import {
  fileRequestLimitsSchema,
  type FileRequest,
  type FileRequestSummary,
} from "./file-request";
import { mutateFiles } from "./file-mutations";
import { requireExisting, safePath } from "./file-operations";
import { protectedProcedure, router } from "./index";

const passwordSchema = z.string().min(8).max(128);

function requireFutureExpiry(expiresAt: number | null) {
  if (expiresAt !== null && expiresAt <= Date.now())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose an expiry date in the future.",
    });
}

const summary = ({ passwordHash, ...request }: FileRequestSummary) => ({
  ...request,
  passwordProtected: passwordHash !== null,
});

const notFound = () =>
  new TRPCError({
    code: "NOT_FOUND",
    message:
      "This file request was revoked or belongs to someone else. Refresh the list.",
  });

export const fileRequestsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    (await ctx.drive.fileRequests.list(ctx.access.user.id)).map(summary),
  ),
  create: protectedProcedure
    .input(
      fileRequestLimitsSchema.extend({
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
        const folder = await requireExisting(target.relative);
        if (!folder.stats.isDirectory())
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Choose a folder to receive files.",
          });
        const request: FileRequest = {
          id: randomUUID(),
          token: randomBytes(32).toString("base64url"),
          path: target.relative,
          createdBy: access.user.id,
          createdAt: Date.now(),
          expiresAt: input.expiresAt,
          passwordHash,
          note: input.note || null,
          maxFileBytes: input.maxFileBytes,
          maxFiles: input.maxFiles,
          maxTotalBytes: input.maxTotalBytes,
        };
        await ctx.drive.fileRequests.create(request);
        recordAudit({
          action: "file_request.created",
          actor: auditUser(access.user),
          target: { type: "file_request", id: request.id, label: request.path },
          details: { passwordProtected: passwordHash !== null, expiresAt: request.expiresAt },
        });
        return { token: request.token };
      });
    }),
  update: protectedProcedure
    .input(
      fileRequestLimitsSchema.extend({
        id: z.string().uuid(),
        password: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("keep") }),
          z.object({ kind: z.literal("set"), value: passwordSchema }),
          z.object({ kind: z.literal("remove") }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireFutureExpiry(input.expiresAt);
      const existing = (
        await ctx.drive.fileRequests.list(ctx.access.user.id)
      ).find((request) => request.id === input.id);
      if (!existing) throw notFound();
      ctx.access.require(existing.path, "admin");
      const updated = await ctx.drive.fileRequests.update(
        existing.id,
        ctx.access.user.id,
        {
          expiresAt: input.expiresAt,
          note: input.note || null,
          maxFileBytes: input.maxFileBytes,
          maxFiles: input.maxFiles,
          maxTotalBytes: input.maxTotalBytes,
          passwordHash:
            input.password.kind === "keep"
              ? existing.passwordHash
              : input.password.kind === "set"
                ? await Bun.password.hash(input.password.value)
                : null,
        },
      );
      if (!updated) throw notFound();
      recordAudit({
        action: "file_request.updated",
        actor: auditUser(ctx.access.user),
        target: { type: "file_request", id: updated.id, label: updated.path },
        details: { password: input.password.kind, expiresAt: updated.expiresAt },
      });
      return { id: updated.id };
    }),
  revoke: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const request = (await ctx.drive.fileRequests.list(ctx.access.user.id)).find(
        (entry) => entry.id === input.id,
      );
      if (!request) return;
      await ctx.drive.fileRequests.revoke(input.id, ctx.access.user.id);
      recordAudit({
        action: "file_request.revoked",
        actor: auditUser(ctx.access.user),
        target: { type: "file_request", id: request.id, label: request.path },
      });
    }),
});
