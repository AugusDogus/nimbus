import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { db } from "../server/db";

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

const trustedOrigins = parseTrustedOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  trustedOrigins,
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  emailAndPassword: {
    enabled: true,
  },
  plugins: [nextCookies()],
});
