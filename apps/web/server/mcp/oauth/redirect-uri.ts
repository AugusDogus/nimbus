/** Real redirect and client URIs are far shorter; the cap bounds what open registration stores. */
export const MAX_URI_LENGTH = 512;

/** Schemes that are never private-use app schemes (RFC 8252 section 7.1). */
const blockedSchemes = new Set([
  "javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "filesystem:", "ftp:", "ws:", "wss:",
]);
const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

export type UriCheck = { ok: true; value: string } | { ok: false; reason: string };

const reject = (reason: string) => ({ ok: false as const, reason });

function parseCommon(value: unknown): { ok: true; url: URL; raw: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.length === 0) return reject("must be a non-empty string");
  if (value.length > MAX_URI_LENGTH) return reject(`must be at most ${MAX_URI_LENGTH} characters`);
  if (/[\s\x00-\x1f\x7f]/.test(value)) return reject("must not contain whitespace or control characters");
  if (value.includes("#")) return reject("must not contain a fragment (#)");
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value)) return reject("must not contain user information (user@host)");
  if (!URL.canParse(value)) return reject("must be an absolute URI");
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") return reject("must not contain user information (user@host)");
  return { ok: true, url, raw: value };
}

const isLoopbackHttp = (url: URL) => url.protocol === "http:" && loopbackHosts.has(url.hostname);

/**
 * OAuth 2.1 redirect URI rules: https on any host, http only on loopback
 * (native apps), and private-use schemes except script, data, and file schemes.
 */
export function validateRedirectUri(value: unknown): UriCheck {
  const parsed = parseCommon(value);
  if (!parsed.ok) return parsed;
  const { url, raw } = parsed;
  if (blockedSchemes.has(url.protocol)) return reject(`the ${url.protocol} scheme is not allowed`);
  if (url.protocol === "http:" && !isLoopbackHttp(url))
    return reject("http is only allowed for loopback hosts (127.0.0.1, [::1], localhost); use https");
  if (url.protocol === "https:" && url.hostname === "") return reject("https URIs need a host");
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.href.length <= url.protocol.length)
    return reject("custom-scheme URIs need a path");
  return { ok: true, value: raw };
}

/** Informational client_uri: https, or http on loopback. */
export function validateWebUri(value: unknown): UriCheck {
  const parsed = parseCommon(value);
  if (!parsed.ok) return parsed;
  return parsed.url.protocol === "https:" || isLoopbackHttp(parsed.url)
    ? { ok: true, value: parsed.raw }
    : reject("must be an https URI");
}

const loopbackAddress = /^(127(\.\d{1,3}){3}|\[::1\]|localhost)$/;

/**
 * Whether a requested redirect URI names a registered one. Exact match, except
 * that loopback hosts are interchangeable (RFC 8252 section 7.3): Next.js
 * rewrites 127.0.0.1 and [::1] to localhost anywhere in a request URL,
 * including inside the redirect_uri query value.
 */
export function matchesRegisteredRedirect(registered: string, requested: string) {
  if (registered === requested) return true;
  if (!URL.canParse(registered) || !URL.canParse(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  if (a.protocol !== "http:" || b.protocol !== "http:") return false;
  if (!loopbackAddress.test(a.hostname) || !loopbackAddress.test(b.hostname)) return false;
  a.hostname = "localhost";
  b.hostname = "localhost";
  return a.href === b.href;
}
