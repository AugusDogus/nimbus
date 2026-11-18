import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { auditUser, recordAudit } from "./audit";
import { safePath } from "./file-operations";
import {
  HomeContainerSharing,
  sharingKindSchema,
} from "./home-container-sharing";
import { Homes } from "./homes";
import { protectedProcedure } from "./index";

/** The setting as the audit log names it. */
const setting = {
  type: "setting",
  id: "allow_home_container_sharing",
  label: "Allow sharing the home folders container",
} as const;

const requireOwnSession = (ownSession: boolean) => {
  if (!ownSession)
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Only a server administrator signed in to their own account in the browser can change this setting, not while signed in as someone else or through an app password or MCP client. Nothing was changed. Sign in as yourself and try again.",
    });
};

/**
 * The "Allow sharing the home folders container" setting, and the sharing that covers the
 * container, for administrators to review. Part of the `access` router.
 */
export const homeContainerSharingProcedures = {
  /** What sharing `path` would expose, for the sharing dialogs to warn before they confirm. */
  homeFoldersExposure: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      ctx.access.require(target.relative, "admin");
      return HomeContainerSharing.exposure(ctx.drive, target.relative);
    }),
  homeContainerSharing: protectedProcedure.query(async ({ ctx }) => {
    ctx.access.requireAdmin();
    const [allowed, records, homes, users, groups] = await Promise.all([
      ctx.drive.homeContainerSharingAllowed(),
      Homes.sharingOverContainers(ctx.drive),
      ctx.drive.listHomes(),
      ctx.drive.listUsers(),
      ctx.drive.listGroups(),
    ]);
    const email = (id: string) =>
      users.find((user) => user.id === id)?.email ?? "Removed account";
    return {
      allowed,
      homes: homes.length,
      containers: await Homes.containers(ctx.drive),
      records: {
        grants: records.grants.map((grant) => ({
          id: grant.id,
          path: grant.path,
          permission: grant.permission,
          subject:
            grant.subject.type === "user"
              ? email(grant.subject.id)
              : `Group: ${groups.find((group) => group.id === grant.subject.id)?.name ?? "Removed group"}`,
        })),
        links: records.links.map((link) => ({
          id: link.id,
          path: link.path,
          createdBy: email(link.createdBy),
          createdAt: link.createdAt,
        })),
        fileRequests: records.fileRequests.map((request) => ({
          id: request.id,
          path: request.path,
          createdBy: email(request.createdBy),
          createdAt: request.createdAt,
        })),
      },
    };
  }),
  setHomeContainerSharing: protectedProcedure
    .input(z.object({ allowed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      ctx.access.requireAdmin();
      requireOwnSession(ctx.ownSession);
      const previous = await HomeContainerSharing.setAllowed(
        ctx.drive,
        input.allowed,
        ctx.access.user.id,
      );
      if (previous !== input.allowed)
        recordAudit({
          action: "setting.changed",
          actor: auditUser(ctx.access.user),
          target: setting,
          details: { previous, allowed: input.allowed },
        });
      return { allowed: input.allowed };
    }),
  /** Remove one grant, public link or upload link that covers the container. */
  removeHomeContainerSharing: protectedProcedure
    .input(z.object({ kind: sharingKindSchema, id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      ctx.access.requireAdmin();
      const records = await Homes.sharingOverContainers(ctx.drive);
      const actor = auditUser(ctx.access.user);
      const gone = () =>
        new TRPCError({
          code: "NOT_FOUND",
          message:
            "This sharing was already removed or no longer covers the home folders container. Nothing was changed. Refresh the list.",
        });
      if (input.kind === "grant") {
        const grant = records.grants.find((entry) => entry.id === input.id);
        if (!grant) throw gone();
        await ctx.drive.removeGrant(grant.id);
        recordAudit({
          action: "grant.removed",
          actor,
          target: { type: "path", id: grant.path },
          details: {
            subjectType: grant.subject.type,
            subjectId: grant.subject.id,
            permission: grant.permission,
          },
        });
      } else if (input.kind === "link") {
        const link = records.links.find((entry) => entry.id === input.id);
        if (!link) throw gone();
        await ctx.drive.revokeShare(link.id, link.createdBy);
        recordAudit({
          action: "share.revoked",
          actor,
          target: { type: "share", id: link.id, label: link.path },
        });
      } else {
        const request = records.fileRequests.find(
          (entry) => entry.id === input.id,
        );
        if (!request) throw gone();
        await ctx.drive.fileRequests.revoke(request.id, request.createdBy);
        recordAudit({
          action: "file_request.revoked",
          actor,
          target: { type: "file_request", id: request.id, label: request.path },
        });
      }
    }),
};
