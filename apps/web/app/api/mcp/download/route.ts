import { getAccess } from "@nimbus/api/access";
import { entryAt } from "@nimbus/api/file-browser";
import { httpDriveStore, httpError, serveFile, serveZip } from "@/server/http-files";
import { verifyDownloadLink } from "@/server/mcp/download-link";
import { liveConnectionUser } from "@/server/mcp/oauth/connections";
import { json } from "@/server/mcp/oauth/http";
import { withMcp } from "@/server/mcp/runtime";

const refused = (status: number, description: string) =>
  json({ error: "download_refused", error_description: description }, { status });

/**
 * Downloads for links from the MCP get_download_link tool. Each request
 * re-checks the link signature and expiry, the connection, the account, and
 * its read permission, so revoking any of them stops the link at once.
 */
export const GET = (request: Request) =>
  withMcp("download", async (oauth) => {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const link = verifyDownloadLink(oauth.secret, token, oauth.now());
    if (link.kind === "invalid") return refused(404, "This download link is not valid. Ask the AI client for a new one.");
    if (link.kind === "expired") return refused(410, "This download link has expired. Ask the AI client for a new one.");
    const userId = await liveConnectionUser(oauth.db, link.grantId);
    if (userId === null)
      return refused(403, "The connection that created this link was revoked or its account is disabled. Nothing was downloaded.");
    try {
      const access = await getAccess(httpDriveStore, userId);
      const entry = await entryAt(link.path);
      return entry.type === "dir"
        ? await serveZip(link.path, access, request.method === "HEAD")
        : await serveFile(request, link.path, access);
    } catch (error) {
      return httpError(error);
    }
  });
export const HEAD = GET;
