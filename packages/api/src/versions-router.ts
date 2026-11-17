import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getAccess, type Access } from "./access";
import { auditUser, recordAudit } from "./audit";
import { getDataRoot } from "./data-root";
import { publishFileEvent } from "./file-events";
import { mutateFiles } from "./file-mutations";
import { requireExisting, safePath } from "./file-operations";
import { FileVersions } from "./file-versions";
import { protectedProcedure, router } from "./index";

/**
 * The file at `requested`, once `access` may read it. Permission comes first, so someone
 * without access cannot tell an existing file from a missing one or a folder.
 */
export async function readableFile(
  access: Pick<Access, "require">,
  requested: string,
) {
  const target = await safePath(requested);
  access.require(target.relative, "read");
  return requireFile(target.relative);
}

async function requireFile(requested: string) {
  const target = await requireExisting(requested);
  if (!target.stats.isFile())
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Folders have no version history. Choose a file.",
    });
  return target;
}

export const versionsRouter = router({
  list: protectedProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ ctx, input }) => {
      const target = await readableFile(ctx.access, input.path);
      const versions = await FileVersions.history(
        ctx.drive.versions,
        target.relative,
      );
      const authors = new Map<string, string>();
      for (const id of new Set(
        versions.flatMap((version) => version.archivedBy ?? []),
      ))
        authors.set(id, (await ctx.drive.getUser(id))?.name ?? "Former user");
      return versions.map(({ path: _path, archivedBy, ...version }) => ({
        ...version,
        archivedBy:
          archivedBy === null ? null : (authors.get(archivedBy) ?? null),
      }));
    }),
  restore: protectedProcedure
    .input(z.object({ path: z.string(), id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const target = await safePath(input.path);
      ctx.access.require(target.relative, "write");
      return mutateFiles(
        [target.relative],
        { userId: ctx.access.user.id },
        async () => {
          const access = await getAccess(ctx.drive, ctx.access.user.id);
          access.require(target.relative, "write");
          await requireFile(target.relative);
          const result = await FileVersions.restore({
            drive: ctx.drive,
            dataRoot: getDataRoot(),
            path: target.relative,
            id: input.id,
            archivedBy: access.user.id,
          });
          if (result.kind === "not-found")
            throw new TRPCError({
              code: "NOT_FOUND",
              message:
                "That version no longer exists. Refresh the version list.",
            });
          publishFileEvent({
            path: target.absolute,
            event: "change",
            ts: Date.now(),
          });
          recordAudit({
            action: "version.restored",
            actor: auditUser(access.user),
            target: { type: "path", id: target.relative },
            details: { versionId: input.id },
          });
          return { restored: true };
        },
      );
    }),
});
