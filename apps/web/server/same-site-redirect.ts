/** Any origin works: a location that keeps it names a path on this site. */
const PROBE_ORIGIN = "https://same-site.invalid";

/**
 * A redirect within this site, sent with a relative Location: path, query and hash only. Behind
 * a proxy that terminates TLS the request URL is http://, so a Location resolved against it
 * would send browsers to plain HTTP, or to the proxy's internal host. Only a path on this site
 * is accepted, so no destination, whatever it was built from, can send the visitor elsewhere.
 */
export const SameSiteRedirect = {
  /** `location` as a path on this site, or null when it could name another host or scheme. */
  path(location: string): string | null {
    if (
      !location.startsWith("/") ||
      location.startsWith("//") ||
      location.includes("\\") ||
      /[\x00-\x20\x7f]/.test(location) ||
      !URL.canParse(location, PROBE_ORIGIN)
    )
      return null;
    const url = new URL(location, PROBE_ORIGIN);
    return url.origin === PROBE_ORIGIN
      ? `${url.pathname}${url.search}${url.hash}`
      : null;
  },

  /**
   * A 307 to `location`. A location off this site is a bug in whatever chose it, so it throws,
   * which answers the request with an error instead of following it.
   */
  response(location: string): Response {
    const path = SameSiteRedirect.path(location);
    if (path === null)
      throw new Error(
        `Nimbus refused to redirect to ${JSON.stringify(location)}: only paths on this site are followed, so the visitor was not sent there. The page that chose this destination has a bug; report this line.`,
      );
    return new Response(null, { status: 307, headers: { Location: path } });
  },
} as const;
