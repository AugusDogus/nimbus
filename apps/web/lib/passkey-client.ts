import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/** Cancels the WebAuthn ceremony in flight, as starting another one would. */
export { WebAuthnAbortService } from "@simplewebauthn/browser";

/**
 * WebAuthn ceremonies. Load with `import("@/lib/passkey-client")` when a passkey
 * action starts, so screens do not ship the WebAuthn helpers in their first load.
 */
export const passkeyAuthClient = createAuthClient({
  plugins: [passkeyClient()],
});
