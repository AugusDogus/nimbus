import { auditUser, recordAudit } from "@nimbus/api/audit";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { Backup } from "@/server/backup";
import { httpError, requestAccess } from "@/server/http-files";
import { getConfigRoot } from "@/server/storage-paths";

type Context = { params: Promise<{ name: string }> };

/** Download a completed backup. Server administrators only. */
export async function GET(request: Request, context: Context) {
  try {
    const access = await requestAccess(request);
    access.requireAdmin();
    const { name } = await context.params;
    const location = Backup.file(path.join(getConfigRoot(), "backups"), name);
    const file = location ? Bun.file(location) : null;
    if (!file || !(await file.exists()))
      throw new TRPCError({
        code: "NOT_FOUND",
        message:
          "That backup no longer exists. Refresh the list; older backups are removed as new ones are made.",
      });
    recordAudit({
      action: "backup.downloaded",
      actor: auditUser(access.user),
      target: { type: "backup", id: name },
    });
    return new Response(file.stream(), {
      headers: {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Length": String(file.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return httpError(error);
  }
}
