import { randomBytes } from "node:crypto";

/**
 * Response hardening applied by the server. HTML documents get a nonce-based
 * Content-Security-Policy: the server writes a fresh nonce into every script tag it sends, so
 * injected scripts are refused. API, WebDAV and static file responses keep their own policies
 * (file previews use a sandbox policy).
 */
export type SecurityMode = { development: boolean; https: boolean };

/** Per-document additions to the policy. */
export type DocumentPolicy = {
  /**
   * `same-origin` (the default) sends `form-action 'self'`. `unrestricted` sends no
   * `form-action` at all, and is only for the MCP consent page: its decision answers with a
   * redirect to the client, and Chromium checks `form-action` against every later redirect
   * after a form submission, not only the first. A hosted client's callback redirects onward
   * (to its sign-in or app host), which Nimbus cannot know or list, so any `form-action`
   * blocks the user's return to the client. Every other directive stays in place.
   */
  formRedirects?: "same-origin" | "unrestricted";
};

export const SecurityHeaders = {
  nonce() {
    return randomBytes(16).toString("base64");
  },
  policy(nonce: string, mode: SecurityMode, document: DocumentPolicy = {}) {
    return [
      "default-src 'self'",
      // React development tooling evaluates code; production never needs eval.
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${mode.development ? " 'unsafe-eval'" : ""}`,
      "script-src-attr 'none'",
      // Sonner, Base UI and React style attributes need inline styles.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self'",
      `connect-src 'self'${mode.development ? " ws: wss:" : ""} https://open-vsx.org https://openvsx.eclipsecontent.org`,
      "worker-src 'self' blob:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      ...(document.formRedirects === "unrestricted"
        ? []
        : ["form-action 'self'"]),
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
  document(
    nonce: string,
    mode: SecurityMode,
    document: DocumentPolicy = {},
  ): Record<string, string> {
    return {
      "Content-Security-Policy": SecurityHeaders.policy(nonce, mode, document),
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self), clipboard-write=(self)",
      "Cross-Origin-Opener-Policy": "same-origin",
    };
  },
} as const;
