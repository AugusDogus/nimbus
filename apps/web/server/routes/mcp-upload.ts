import { FilesystemCapacity } from "@nimbus/api/filesystem-capacity";
import type { RouteContext } from "@/server/http-route";
import { httpDriveStore } from "@/server/http-files";
import { allowedOrigins } from "@/server/mcp/request-guard";
import { withMcp } from "@/server/mcp/runtime";
import { McpUpload } from "@/server/mcp/upload";

/**
 * Uploads for links from the MCP get_upload_link tool: `PUT <link>` for a file link, or
 * `PUT <link>/<relative path>` below a folder link's folder. No cookies are read and no CORS
 * headers are sent, so only a client holding the link can use it.
 */
export const PUT = (
  request: Request,
  context: RouteContext<{ token: string; rest: string }>,
) =>
  withMcp("upload", async (oauth) =>
    McpUpload.handle(
      {
        db: oauth.db,
        drive: httpDriveStore,
        secret: oauth.secret,
        origins: allowedOrigins(
          oauth.origin,
          process.env.BETTER_AUTH_TRUSTED_ORIGINS,
        ),
        now: oauth.now,
        capacity: FilesystemCapacity.read,
      },
      request,
      await context.params,
    ),
  );
