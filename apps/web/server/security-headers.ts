import { randomBytes } from "node:crypto";

/**
 * Response hardening applied by the custom server. Document responses get a nonce-based
 * Content-Security-Policy: Next.js reads the nonce from the request's policy header and
 * adds it to its own scripts, so injected inline scripts are refused. API, WebDAV and
 * static asset responses keep their own policies (file previews use a sandbox policy).
 */
export type SecurityMode = { development: boolean; https: boolean };

/** Request header carrying the document nonce to server components. Set only by the custom server. */
export const nonceHeader = "x-nimbus-nonce";

const documentExclusions = /^\/(?:api|dav|_next)(?:\/|$)|^\/(?:icon\.svg|favicon\.ico)$/;

export const SecurityHeaders = {
  isDocument(pathname: string) {
    return !documentExclusions.test(pathname);
  },
  nonce() {
    return randomBytes(16).toString("base64");
  },
  policy(nonce: string, mode: SecurityMode) {
    return [
      "default-src 'self'",
      // React development tooling evaluates code; production never needs eval.
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${mode.development ? " 'unsafe-eval'" : ""}`,
      "script-src-attr 'none'",
      // Sonner, Vaul, Radix and React style attributes need inline styles.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self'",
      `connect-src 'self'${mode.development ? " ws: wss:" : ""} https://open-vsx.org https://openvsx.eclipsecontent.org`,
      "worker-src 'self' blob:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(mode.https ? ["upgrade-insecure-requests"] : []),
    ].join("; ");
  },
  /** Headers for every response, including WebDAV and API routes. */
  common(mode: SecurityMode): Record<string, string> {
    return {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(mode.https && { "Strict-Transport-Security": "max-age=31536000" }),
    };
  },
  /** Additional headers for HTML documents. */
  document(nonce: string, mode: SecurityMode): Record<string, string> {
    return {
      "Content-Security-Policy": SecurityHeaders.policy(nonce, mode),
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self), clipboard-write=(self)",
      "Cross-Origin-Opener-Policy": "same-origin",
    };
  },
} as const;
