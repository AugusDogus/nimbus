/**
 * Stands in for the Content-Security-Policy nonce in the built HTML. The server replaces it
 * with a fresh nonce in every page it sends; it never reaches a browser.
 */
export const htmlNonce = "__NIMBUS_CSP_NONCE__";
