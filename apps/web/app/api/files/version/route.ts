import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import { requireExisting } from "@nimbus/api/file-operations";
import { FileVersions } from "@nimbus/api/file-versions";
import { httpDriveStore, httpError, requestAccess } from "@/server/http-files";

/** Download a previous version of a file the caller can read. */
export async function GET(request: Request) {
  try {
    const access = await requestAccess(request);
    const url = new URL(request.url);
    const target = await requireExisting(url.searchParams.get("path") ?? "");
    access.require(target.relative, "read");
    const found = await FileVersions.find(
      httpDriveStore.versions,
      target.absolute,
      url.searchParams.get("id") ?? "",
    );
    if (!found)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "That version no longer exists. Refresh the version list.",
      });
    const file = Bun.file(found.payload(getDataRoot()));
    const ext = path.extname(found.version.name);
    const stamp = new Date(found.version.modifiedAt).toISOString().slice(0, 19).replaceAll(":", "-");
    const name = `${path.basename(found.version.name, ext)} (${stamp})${ext}`;
    return new Response(file.stream(), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Content-Length": String(file.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return httpError(error);
  }
}
