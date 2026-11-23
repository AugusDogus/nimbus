import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, genericOAuth, twoFactor } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { auditUser, recordAudit } from "@nimbus/api/audit";
import { Homes } from "@nimbus/api/homes";
import { grants, groupMembers, groups, trash, user } from "../server/db/schema";
import { ClientIp, clientIpHeader } from "../server/client-ip";
import type { Database } from "../server/db/connection";
import type { MailMessage } from "../server/mail";
import { createDriveStore } from "../server/drive-store";
import { revokeUserConnections } from "../server/mcp/oauth/connections";
import { DEVICE_REVOCATION_REASONS } from "../server/db/library-schema";
import { PairedDevices } from "../server/libraries/paired-devices";
import { RateLimiter } from "../server/rate-limit";
import { finishAuthResponse, nimbusAudit } from "./auth-audit";
import { nimbusSecurity } from "./auth-security";
import { OidcConfig, oidcProviderId } from "./oidc-config";
import { PasswordAttempts } from "./password-attempts";
import { totpReplayGuard } from "./totp-replay";

/**
 * What the Nimbus Better Auth configuration depends on. `auth.ts` builds it from the
 * environment; tests pass a migrated temporary database and their own settings.
 */
export type NimbusAuthOptions = {
  db: Database;
  oidc: OidcConfig;
  /** Sends password reset email, or null when SMTP is off. */
  sendMail: ((message: MailMessage) => Promise<void>) | null;
  /** The public origin: BETTER_AUTH_URL, or the local default when it is unset. */
  origin: PublicOrigin;
  trustedOrigins: string[];
  /** Tests only; the server reads BETTER_AUTH_SECRET from the environment. */
  secret?: string;
};

export type PublicOrigin =
  | { kind: "configured"; url: URL }
  | { kind: "local-default"; url: URL };

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

/** A social sign-in body that carries an ID token, in any shape. */
const postsIdToken = z.object({
  idToken: z.unknown().refine((value) => value !== undefined),
});

const signInBody = z.object({ email: z.string() });

/** The rate-limit bucket of the address the server derived for this request. */
const clientAddress = (headers: Headers | undefined) =>
  ClientIp.bucket(headers?.get(clientIpHeader) ?? "unknown");

const registrationClosed = () =>
  new APIError("FORBIDDEN", {
    message:
      "Registration is closed. Ask your server administrator to create an account.",
  });

export function createNimbusAuth({
  db,
  oidc: oidcConfig,
  sendMail,
  origin,
  trustedOrigins,
  secret,
}: NimbusAuthOptions) {
  const publicOrigin = origin.url;
  // Without a configured origin Better Auth builds links from the request's Host header,
  // which anyone can set, so an emailed reset link could point at another site.
  if (sendMail && origin.kind !== "configured")
    throw new Error(
      "Nimbus email is configured but BETTER_AUTH_URL is not set. Set BETTER_AUTH_URL to the public address of this server, such as https://files.example.com, so password reset links point at it. Nimbus did not start; no accounts or settings were changed.",
    );
  const passwordAttempts = PasswordAttempts.create();
  // The account-security actions that end MCP connections end paired devices too.
  const disconnectMcpClients = async (userId: string, by: string) => {
    const reason = DEVICE_REVOCATION_REASONS.find((known) => known === by);
    if (reason)
      await PairedDevices.revokeForUser({ db, now: Date.now }, userId, reason);
    return revokeUserConnections(db, userId, Date.now(), by);
  };
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
  const pendingGroups = new Map<
    string,
    { groups: string[]; expires: number }
  >();

  async function syncProviderGroups(userId: string, email: string) {
    const key = email.toLowerCase();
    const pending = pendingGroups.get(key);
    pendingGroups.delete(key);
    if (!pending || pending.expires < Date.now()) return;
    // The provider is the source of truth for all of this person's group memberships:
    // groups it names are joined and every other membership is removed, so access ends
    // when the provider drops someone from a group. Groups are never created here.
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

  return betterAuth({
    ...(secret !== undefined && { secret }),
    ...(origin.kind === "configured" && { baseURL: origin.url.origin }),
    database: drizzleAdapter(db, {
      provider: "sqlite",
    }),
    trustedOrigins,
    // Nimbus has no UI for these. Two take session tokens, which never reach the browser
    // (Nimbus revokes sessions by ID), and the rest link, unlink or hand out provider tokens.
    disabledPaths: [
      "/link-social",
      "/unlink-account",
      "/revoke-session",
      "/admin/revoke-user-session",
      "/get-access-token",
      "/refresh-token",
    ],
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
        // Refused before Better Auth looks up the address, so the answer never reveals
        // whether an account uses it.
        // Better Auth also accepts a provider's ID token posted here. Nimbus's single sign-on
        // rules (verified email, administrator first, group sync, audit) apply to the
        // provider's redirect, so that is the only way in.
        if (
          context.path === "/sign-in/social" &&
          postsIdToken.safeParse(context.body).success
        )
          throw new APIError("BAD_REQUEST", {
            message:
              "Sign in with single sign-on from the Nimbus sign-in page. Posting an ID token is not supported, and no account was signed in or created.",
          });
        if (context.path === "/sign-in/email") {
          const attempt = signInBody.safeParse(context.body);
          if (!attempt.success) return;
          const decision = passwordAttempts.admit(
            attempt.data.email,
            clientAddress(context.headers),
          );
          if (!decision.allowed)
            throw new APIError(
              "TOO_MANY_REQUESTS",
              {
                code: "too_many_attempts_for_account",
                message: `Too many sign-in attempts for this account. Wait ${RateLimiter.seconds(decision.retryAfterSeconds)} and try again, or sign in with a passkey. The account is not locked, and your password is unchanged.`,
              },
              { "Retry-After": String(decision.retryAfterSeconds) },
            );
          return;
        }
        if (context.path === "/sign-up/email") {
          const [existing] = await db
            .select({ id: user.id })
            .from(user)
            .limit(1);
          if (existing) throw registrationClosed();
          return;
        }
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
        if (
          context.path === "/sign-in/email" &&
          !(context.context.returned instanceof APIError)
        ) {
          const attempt = signInBody.safeParse(context.body);
          if (attempt.success)
            passwordAttempts.succeeded(
              attempt.data.email,
              clientAddress(context.headers),
            );
          return;
        }
        if (!isOidcCallback(context.path)) return;
        const created = z
          .object({ user: z.object({ id: z.string(), email: z.string() }) })
          .safeParse(context.context.newSession);
        if (
          created.success &&
          oidcConfig.kind === "oidc" &&
          oidcConfig.groupsClaim
        )
          await syncProviderGroups(
            created.data.user.id,
            created.data.user.email,
          );
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
      async onPasswordReset({ user: account }) {
        await disconnectMcpClients(account.id, "password_reset");
      },
      resetPasswordTokenExpiresIn: 60 * 60,
      ...(sendMail && {
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
              throw registrationClosed();
            if (isOidcCallback(context?.path ?? undefined)) {
              // A code sends the callback to the sign-in page, which explains it.
              if (!existing)
                throw new APIError("FORBIDDEN", {
                  code: "administrator_required",
                  message:
                    "Create the administrator account with a password before using single sign-on.",
                });
              if (data.emailVerified !== true)
                throw new APIError("FORBIDDEN", {
                  code: "email_not_verified",
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
            // A disabled account's devices are disconnected, so enabling it again revives none.
            // Here, not after a route: administrators disable accounts with ban-user and with
            // update-user, and any later way of setting `banned` comes through here too.
            if (updated.banned === true)
              await PairedDevices.revokeForUser(
                { db, now: Date.now },
                updated.id,
                "account_disabled",
              );
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
      totpReplayGuard(),
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
      nimbusSecurity({
        appPasswords: createDriveStore(db),
        disconnectMcpClients,
      }),
      // Append new plugins above this line. Audit observes final results, so it stays last.
      nimbusAudit(),
    ],
  });
}

/** Serves one /api/auth request, as the server's auth route does. */
export const handleAuthRequest = async (
  auth: { handler: (request: Request) => Promise<Response> },
  request: Request,
) => finishAuthResponse(request, await auth.handler(request));
