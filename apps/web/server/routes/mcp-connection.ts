import { revokeConnection } from "@/server/mcp/oauth/connections";
import { json } from "@/server/mcp/oauth/http";
import { withMcp } from "@/server/mcp/runtime";

/** Settings → MCP: disconnect one of the signed-in user's own clients. */
export const DELETE = (
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) =>
  withMcp("revoke connection", async (oauth) => {
    if (request.headers.get("origin") !== oauth.origin)
      return json(
        {
          error:
            "This request did not come from Nimbus Settings. Nothing was disconnected.",
        },
        { status: 403 },
      );
    const session = await oauth.getSession(request.headers);
    if (!session)
      return json(
        {
          error:
            "Your session ended. Sign in again, then retry. Nothing was disconnected.",
        },
        { status: 401 },
      );
    const revoked = await revokeConnection(
      oauth.db,
      session.userId,
      (await params).id,
      oauth.now(),
    );
    return revoked
      ? new Response(null, { status: 204 })
      : json(
          {
            error:
              "This app is already disconnected. Reload the page to see current connections.",
          },
          { status: 404 },
        );
  });
