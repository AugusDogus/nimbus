import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/**
 * WebAuthn ceremonies. Load with `import("@/lib/passkey-client")` when a passkey
 * action starts, so screens do not ship the WebAuthn helpers in their first load.
 */
export const passkeyAuthClient = createAuthClient({ plugins: [passkeyClient()] });
