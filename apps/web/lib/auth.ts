import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin, genericOAuth, twoFactor } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { auditUser, recordAudit } from "@nimbus/api/audit";
import { Homes } from "@nimbus/api/homes";
import { grants, groupMembers, groups, trash, user } from "../server/db/schema";
import { clientIpHeader } from "../server/client-ip";
import { mailConfig, sendMail } from "../server/mail";
import { db } from "../server/db";
import { createDriveStore } from "../server/drive-store";
import { RateLimiter } from "../server/rate-limit";
import { nimbusAudit } from "./auth-audit";
import { nimbusSecurity } from "./auth-security";
import { OidcConfig, oidcConfig, oidcProviderId } from "./oidc-config";

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
// Single sign-on is the only OAuth provider, so every OAuth callback belongs to it.
// Better Auth may report the templated route ("/callback/:id") rather than the URL.
const isOidcCallback = (path: string | undefined) =>
  oidcConfig.kind === "oidc" && (path?.startsWith("/callback/") ?? false);

// Caps reset emails per account so many clients cannot flood one mailbox.
const resetEmails = RateLimiter.shared("password-reset-recipient", {
  limit: 3,
  windowMs: 60 * 60 * 1000,
});

/** Groups claimed by the identity provider at sign-in, applied once the account is known. */
const pendingGroups = new Map<string, { groups: string[]; expires: number }>();

async function syncProviderGroups(userId: string, email: string) {
  const key = email.toLowerCase();
  const pending = pendingGroups.get(key);
  pendingGroups.delete(key);
  if (!pending || pending.expires < Date.now()) return;
  // The provider is the source of truth for membership in groups it names.
  const matched = pending.groups.length
    ? await db
        .select({ id: groups.id })
        .from(groups)
        .where(inArray(groups.name, pending.groups))
    : [];
  const ids = matched.map((group) => group.id);
  // Synchronous, so the transaction commits exactly these statements.
  db.transaction((tx) => {
    tx.delete(groupMembers)
      .where(
        ids.length
          ? and(
              eq(groupMembers.userId, userId),
              notInArray(groupMembers.groupId, ids),
            )
          : eq(groupMembers.userId, userId),
      )
      .run();
    if (ids.length)
      tx.insert(groupMembers)
        .values(ids.map((groupId) => ({ groupId, userId })))
        .onConflictDoNothing()
        .run();
  });
  recordAudit({
    action: "account.updated",
    actor: { type: "system" },
    target: { type: "user", id: userId, label: email },
    details: { groupsFromProvider: pending.groups.join(",") },
  });
}

const oidcPlugins: BetterAuthPlugin[] =
  oidcConfig.kind === "oidc"
    ? [
        genericOAuth({
          config: [
            {
              providerId: oidcProviderId,
              name: oidcConfig.label,
              clientId: oidcConfig.clientId,
              clientSecret: oidcConfig.clientSecret,
              discoveryUrl: OidcConfig.discoveryUrl(oidcConfig),
              scopes: ["openid", "profile", "email"],
              requireIdTokenVerification: true,
              requireEmailVerification: true,
              disableSignUp: !oidcConfig.autoProvision,
              overrideUserInfo: false,
              mapProfileToUser(profile) {
                const groupsClaim =
                  oidcConfig.kind === "oidc" ? oidcConfig.groupsClaim : null;
                if (groupsClaim && typeof profile.email === "string")
                  pendingGroups.set(profile.email.toLowerCase(), {
                    groups: OidcConfig.groups(profile, groupsClaim),
                    expires: Date.now() + 5 * 60 * 1000,
                  });
                return {};
              },
            },
          ],
        }),
      ]
    : [];

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
  }),
  trustedOrigins,
  advanced: {
    // The custom server derives this header from the socket and NIMBUS_TRUSTED_PROXIES.
    ipAddress: { ipAddressHeaders: [clientIpHeader] },
    useSecureCookies: publicOrigin.protocol === "https:",
  },
  rateLimit: {
    enabled: true,
    storage: "memory",
    window: 60,
    max: 600,
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 3600, max: 10 },
      "/request-password-reset": { window: 3600, max: 5 },
      "/reset-password": { window: 3600, max: 10 },
      "/change-password": { window: 600, max: 10 },
      "/two-factor/*": { window: 60, max: 10 },
      "/passkey/verify-authentication": { window: 60, max: 20 },
      "/get-session": false,
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [],
      allowDifferentEmails: false,
    },
  },
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
    after: createAuthMiddleware(async (context) => {
      if (!isOidcCallback(context.path)) return;
      const created = z
        .object({ user: z.object({ id: z.string(), email: z.string() }) })
        .safeParse(context.context.newSession);
      if (
        created.success &&
        oidcConfig.kind === "oidc" &&
        oidcConfig.groupsClaim
      )
        await syncProviderGroups(created.data.user.id, created.data.user.email);
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
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60,
    ...(mailConfig.kind === "smtp" && {
      async sendResetPassword({ user: account, url }) {
        // The response stays the same either way, so this reveals nothing to the requester.
        if (!resetEmails.consume(account.id).allowed) return;
        // Deliver in the background so response timing does not reveal whether an account exists.
        void sendMail({
          to: account.email,
          subject: "Reset your Nimbus password",
          text: `Someone asked to reset the password for your Nimbus account.\n\nOpen this link within one hour to choose a new password:\n${url}\n\nIf you did not ask for this, ignore this email. Your password has not changed.`,
          html: `<p>Someone asked to reset the password for your Nimbus account.</p><p><a href="${encodeURI(url)}">Choose a new password</a>. The link works for one hour.</p><p>If you did not ask for this, ignore this email. Your password has not changed.</p>`,
        }).catch((error: unknown) =>
          console.error(
            `Nimbus could not send a password reset email for account ${account.id}. The reset link was not delivered; the password is unchanged. Check the NIMBUS_SMTP_* settings and the mail server logs.`,
            error,
          ),
        );
      },
    }),
  },
  databaseHooks: {
    user: {
      create: {
        async before(data, context) {
          const [existing] = await db
            .select({ id: user.id })
            .from(user)
            .limit(1);
          if (context?.path === "/sign-up/email" && existing)
            throw new APIError("FORBIDDEN", {
              message:
                "Registration is closed. Ask your server administrator to create an account.",
            });
          if (isOidcCallback(context?.path ?? undefined)) {
            if (!existing)
              throw new APIError("FORBIDDEN", {
                message:
                  "Create the administrator account with a password before using single sign-on.",
              });
            if (data.emailVerified !== true)
              throw new APIError("FORBIDDEN", {
                message:
                  "Your identity provider has not verified your email address, so Nimbus did not create an account. Verify it with your provider and try again.",
              });
            return { data };
          }
          // Registration is closed: the only self-created account is the first, and
          // administrators enter every other address themselves. Nimbus treats those
          // addresses as verified, which single sign-on relies on to link identities.
          return { data: { ...data, emailVerified: true } };
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
          const home = await Homes.provision(createDriveStore(db), created);
          if (home.kind === "failed") console.error(home.message);
        },
      },
      delete: {
        async after(removed) {
          // The home folder and its files stay for administrators; only access is removed.
          await db
            .delete(grants)
            .where(
              and(
                eq(grants.subjectType, "user"),
                eq(grants.subjectId, removed.id),
              ),
            );
        },
      },
      update: {
        async after(updated, context) {
          if (
            context?.path === "/two-factor/verify-totp" &&
            updated.twoFactorEnabled === true
          )
            recordAudit({
              action: "auth.two_factor_enabled",
              actor: auditUser(updated),
            });
        },
      },
    },
  },
  plugins: [
    admin(),
    twoFactor({ issuer: "Nimbus" }),
    passkey({
      rpName: "Nimbus",
      rpID: publicOrigin.hostname,
      origin: publicOrigin.origin,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    }),
    ...oidcPlugins,
    nimbusSecurity({ appPasswords: createDriveStore(db) }),
    // Append new plugins above this line. Audit observes final results; nextCookies must be last.
    nimbusAudit(),
    nextCookies(),
  ],
});
