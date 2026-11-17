/**
 * Event streams may hold their connection open with no idle timeout, and only they. A request
 * that asks for one on an endpoint that serves them, the tRPC subscriptions and MCP, is wired to
 * end when the server shuts down; its timeout is lifted only once the response really is an
 * event stream. Until then, while its body is read and its handler runs, the timeout applies,
 * so a slow client cannot hold connections open by sending `Accept: text/event-stream`.
 */
export const EventStreams = {
  /** Whether `request` may become an event stream. */
  requested(request: Request): boolean {
    if (!request.headers.get("accept")?.includes("text/event-stream"))
      return false;
    const { pathname } = new URL(request.url);
    return pathname.startsWith("/api/trpc/") || pathname === "/api/mcp";
  },
  /** Whether the answer to a `requested` stream may run without the idle timeout. */
  untimed(request: Request, response: Response): boolean {
    return (
      EventStreams.requested(request) &&
      response.body !== null &&
      (response.headers.get("content-type") ?? "").startsWith(
        "text/event-stream",
      )
    );
  },
} as const;
