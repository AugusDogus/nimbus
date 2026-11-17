/**
 * Which requests may hold their connection open with no idle timeout: event streams, on the
 * endpoints that serve them, the tRPC subscriptions and MCP. Any other request keeps the
 * timeout, whatever it asks for, so a slow client cannot hold connections open by sending
 * `Accept: text/event-stream`.
 */
export const EventStreams = {
  untimed(request: Request): boolean {
    if (!request.headers.get("accept")?.includes("text/event-stream"))
      return false;
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api/trpc/") || pathname === "/api/mcp";
  },
} as const;
