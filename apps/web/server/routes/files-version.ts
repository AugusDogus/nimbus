import path from "node:path";
import { TRPCError } from "@trpc/server";
import { getDataRoot } from "@nimbus/api/data-root";
import { FileVersions } from "@nimbus/api/file-versions";
import { readableFile } from "@nimbus/api/versions-router";
import { serveStoredFile } from "@/server/file-response";
import { httpDriveStore, httpError, requestAccess } from "@/server/http-files";

/** Download a previous version of a file the caller can read. */
export async function GET(request: Request) {
  try {
    const access = await requestAccess(request);
    const url = new URL(request.url);
    const target = await readableFile(
      access,
      url.searchParams.get("path") ?? "",
    );
    const found = await FileVersions.find(
      httpDriveStore.versions,
      target.relative,
      url.searchParams.get("id") ?? "",
    );
    if (!found)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "That version no longer exists. Refresh the version list.",
      });
    const ext = path.extname(found.version.name);
    const stamp = new Date(found.version.modifiedAt)
      .toISOString()
      .slice(0, 19)
      .replaceAll(":", "-");
    const name = `${path.basename(found.version.name, ext)} (${stamp})${ext}`;
    return await serveStoredFile(request, found.payload(getDataRoot()), name);
  } catch (error) {
    return httpError(error);
  }
}
