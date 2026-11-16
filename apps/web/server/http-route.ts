/**
 * Path and method matching for the server's HTTP endpoints. Handlers are web-standard functions
 * from `Request` to `Response`; dynamic segments arrive as `context.params`, decoded once.
 */
const methods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
type Method = (typeof methods)[number];

export type RouteContext<P> = { params: Promise<P> };
type Handler<P> = (
  request: Request,
  context: RouteContext<P>,
) => Response | Promise<Response>;
type RouteModule<P> = Partial<Record<Method, Handler<P>>>;

export type Route = {
  /** Returns the request handler when the path matches, or null. */
  match(segments: string[]): ((request: Request) => Promise<Response>) | null;
};

const isMethod = (value: string): value is Method =>
  methods.some((method) => method === value);

/**
 * A route for `pattern`, whose segments are literals, `:name` for one segment, or a final `*`
 * for one or more segments (`*?` also matches none). `params` names the captured values in order;
 * a rest capture is joined with `/`.
 */
export function route<P>(
  pattern: string,
  params: (captures: string[]) => P,
  module: RouteModule<P>,
): Route {
  const parts = pattern.split("/").slice(1);
  // As with any GET resource, HEAD answers with GET's headers; Bun.serve drops the body.
  const handlers: RouteModule<P> = { HEAD: module.GET, ...module };
  const allowed = methods.filter((method) => handlers[method] !== undefined);
  const allow = [...new Set([...allowed, "OPTIONS"])].join(", ");
  return {
    match(segments) {
      const captures: string[] = [];
      for (const [index, part] of parts.entries()) {
        if (part === "*" || part === "*?") {
          const rest = segments.slice(index);
          if (part === "*" && rest.length === 0) return null;
          captures.push(rest.join("/"));
          return dispatch(captures);
        }
        const segment = segments[index];
        if (segment === undefined) return null;
        if (part.startsWith(":")) captures.push(segment);
        else if (part !== segment) return null;
      }
      return segments.length === parts.length ? dispatch(captures) : null;
    },
  };

  function dispatch(captures: string[]) {
    return async (request: Request) => {
      const method = isMethod(request.method) ? request.method : undefined;
      const handler = method && handlers[method];
      if (handler)
        return handler(request, { params: Promise.resolve(params(captures)) });
      if (method === "OPTIONS")
        return new Response(null, { status: 204, headers: { Allow: allow } });
      return new Response(
        `${request.method} is not supported here. Use ${allowed.join(" or ")}.`,
        {
          status: 405,
          headers: {
            Allow: allow,
            "Content-Type": "text/plain; charset=utf-8",
          },
        },
      );
    };
  }
}

/**
 * Splits a request path into decoded segments for `Route.match`. Returns null when a segment has
 * a malformed percent-encoding, which no route matches.
 */
export function pathSegments(pathname: string): string[] | null {
  try {
    return pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
}
