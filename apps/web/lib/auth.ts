import { db } from "../server/db";
import { mailConfig, sendMail } from "../server/mail";
import { createNimbusAuth } from "./nimbus-auth";
import { oidcConfig } from "./oidc-config";

const parseTrustedOrigins = (value: string | undefined) => {
  if (!value) return [];

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        throw new Error(
          `Invalid BETTER_AUTH_TRUSTED_ORIGINS entry: "${origin}". Use full origins like https://example.com`,
        );
      }
    });
};

const trustedOrigins = parseTrustedOrigins(
  process.env.BETTER_AUTH_TRUSTED_ORIGINS,
);
const publicOrigin = new URL(
  process.env.BETTER_AUTH_URL ??
    `http://localhost:${process.env.PORT ?? "3000"}`,
);

/** Origins whose pages may send cookie-authenticated form posts: Nimbus's own and trusted ones. */
export const allowedOrigins: ReadonlySet<string> = new Set([
  publicOrigin.origin,
  ...trustedOrigins,
]);

export const auth = createNimbusAuth({
  db,
  oidc: oidcConfig,
  sendMail: mailConfig.kind === "smtp" ? sendMail : null,
  origin: process.env.BETTER_AUTH_URL
    ? { kind: "configured", url: new URL(process.env.BETTER_AUTH_URL) }
    : {
        kind: "local-default",
        url: new URL(`http://localhost:${process.env.PORT ?? "3000"}`),
      },
  trustedOrigins: [...trustedOrigins],
});
