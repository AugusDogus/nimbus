import { auditUser, recordAudit } from "@nimbus/api/audit";
import { backups, Backup } from "@/server/backup";
import { httpError, requestAccess } from "@/server/http-files";
import { getConfigRoot } from "@/server/storage-paths";
import path from "node:path";

const noStore = { "Cache-Control": "no-store" };

/** Completed database backups. Server administrators only. */
export async function GET(request: Request) {
  try {
    (await requestAccess(request)).requireAdmin();
    return Response.json(
      { backups: await Backup.list(path.join(getConfigRoot(), "backups")) },
      { headers: noStore },
    );
  } catch (error) {
    return httpError(error);
  }
}

/** Back up the database now; joins a backup that is already running. */
export async function POST(request: Request) {
  try {
    const access = await requestAccess(request);
    access.requireAdmin();
    try {
      const backup = await backups().run();
      recordAudit({
        action: "backup.created",
        actor: auditUser(access.user),
        target: { type: "backup", id: backup.name },
        details: { size: backup.size },
      });
      return Response.json({ backup }, { headers: noStore });
    } catch (error) {
      console.error("Nimbus database backup failed.", error);
      return Response.json(
        {
          error:
            "The backup failed. The database and earlier backups are unchanged. Check the server logs for the cause, then try again.",
        },
        { status: 500, headers: noStore },
      );
    }
  } catch (error) {
    return httpError(error);
  }
}
