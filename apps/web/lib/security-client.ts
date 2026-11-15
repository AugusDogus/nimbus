import { createAuthClient } from "better-auth/react";
import type { BetterAuthClientPlugin } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";
import type { nimbusSecurity } from "./auth-security";

const nimbusSecurityClient = () =>
  ({
    id: "nimbus-security",
    $InferServerPlugin: {} as ReturnType<typeof nimbusSecurity>,
  }) satisfies BetterAuthClientPlugin;

/** Second-factor and session management. Import only from screens that manage them. */
export const securityClient = createAuthClient({
  plugins: [twoFactorClient(), nimbusSecurityClient()],
});
