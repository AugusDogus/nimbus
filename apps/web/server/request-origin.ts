/**
 * Whether a cookie-authenticated request that changes something came from Nimbus's own pages.
 * SameSite=Lax cookies still reach a POST from a sibling subdomain ("same-site"). Nimbus pages
 * send Origin "null" (no-referrer policy), which any page can also produce, so only fetch
 * metadata proves the origin then. Every current browser sends it; a request with neither
 * header is not from a browser page, so no browser sent the cookie on anyone's behalf.
 */
export const RequestOrigin = {
  fromNimbus(request: Request, allowedOrigins: ReadonlySet<string>) {
    const site = request.headers.get("sec-fetch-site");
    const from = request.headers.get("origin");
    return site !== null
      ? site === "same-origin" || site === "none"
      : from === null || allowedOrigins.has(from);
  },
} as const;
