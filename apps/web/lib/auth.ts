import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { trash, user } from "../server/db/schema";

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

const trustedOrigins = parseTrustedOrigins(
  process.env.BETTER_AUTH_TRUSTED_ORIGINS,
);

const roleSchema = z.union([z.string(), z.array(z.string())]);
const adminChangeSchema = z.object({
  userId: z.string(),
  role: roleSchema.optional(),
  data: z
    .object({ role: roleSchema.optional(), banned: z.boolean().optional() })
    .optional(),
});
const includesAdmin = (role: string | string[]) =>
  (Array.isArray(role) ? role : role.split(",")).includes("admin");

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  trustedOrigins,
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (
        ![
          "/admin/set-role",
          "/admin/ban-user",
          "/admin/remove-user",
          "/admin/update-user",
        ].includes(context.path)
      )
        return;
      const change = adminChangeSchema.safeParse(context.body);
      if (!change.success) return;
      if (context.path === "/admin/remove-user") {
        const [item] = await db
          .select({ id: trash.id })
          .from(trash)
          .where(eq(trash.deletedBy, change.data.userId))
          .limit(1);
        if (item)
          throw new APIError("CONFLICT", {
            message:
              "This account still has files in trash. Restore or permanently delete those files before removing the account. Its files and account are unchanged.",
          });
      }
      const role = change.data.role ?? change.data.data?.role;
      const removesAccess =
        context.path === "/admin/ban-user" ||
        context.path === "/admin/remove-user" ||
        change.data.data?.banned === true ||
        (role !== undefined && !includesAdmin(role));
      if (!removesAccess) return;
      const users = await db
        .select({ id: user.id, role: user.role, banned: user.banned })
        .from(user);
      const administrators = users.filter(
        (entry) => !entry.banned && includesAdmin(entry.role ?? "user"),
      );
      if (
        administrators.length === 1 &&
        administrators[0]?.id === change.data.userId
      ) {
        throw new APIError("FORBIDDEN", {
          message:
            "Nimbus needs an active administrator. Promote another account before changing this administrator.",
        });
      }
    }),
  },
  session: {
    cookieCache: {
      enabled: false,
      maxAge: 5 * 60,
    },
  },
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      create: {
        async before(data, context) {
          if (context?.path === "/sign-up/email") {
            const [existing] = await db
              .select({ id: user.id })
              .from(user)
              .limit(1);
            if (existing)
              throw new APIError("FORBIDDEN", {
                message:
                  "Registration is closed. Ask your server administrator to create an account.",
              });
          }
          return { data };
        },
        async after(created) {
          // Elect only the earliest account. A later user never becomes an administrator
          // merely because the previous administrator's role has changed.
          await db
            .update(user)
            .set({ role: "admin" })
            .where(
              sql`${user.id} = ${created.id} AND ${user.id} = (SELECT id FROM user ORDER BY created_at, id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM user WHERE instr(',' || role || ',', ',admin,') > 0)`,
            );
        },
      },
    },
  },
  plugins: [admin(), nextCookies()],
});
