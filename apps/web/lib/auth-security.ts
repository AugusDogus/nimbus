import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import encodeQR from "qr";
import { z } from "zod";
import { auditUser, recordAudit } from "@nimbus/api/audit";
import type { DriveStore } from "@nimbus/api/drive-store";

const includesAdmin = (role: string | null | undefined) =>
  (role ?? "").split(",").includes("admin");

/** Renders an otpauth URI as an opaque SVG data URL, so enrollment ships no QR encoder. */
export function totpQrCode(uri: string) {
  const svg = encodeQR(uri, "svg", {
    ecc: "medium",
    border: 4,
    optimize: true,
  }).replace(
    /^<svg([^>]*)>/,
    '<svg$1 shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/>',
  );
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const enableResult = z
  .object({ totpURI: z.string().startsWith("otpauth://totp/") })
  .loose();

/**
 * Actions after which an account's MCP clients must authorize again, as its browsers must.
 * Password resets by email are handled by `onPasswordReset`, which knows the account.
 * Signing out only other browsers leaves MCP clients connected; Settings lists them separately.
 */
const disconnectsMcp: Record<string, string> = {
  "/change-password": "password_changed",
  "/revoke-sessions": "signed_out_everywhere",
  "/admin/revoke-user-sessions": "signed_out_everywhere",
  "/admin/set-user-password": "password_set",
};

/**
 * Nimbus account-security endpoints that Better Auth does not provide:
 * revoking one of your sessions by ID (so session tokens never reach the browser),
 * and an administrator reset of every second factor and WebDAV app password for an account.
 */
export const nimbusSecurity = ({
  appPasswords,
  disconnectMcpClients,
}: {
  appPasswords: Pick<DriveStore, "listAppPasswords" | "removeAppPassword">;
  /** Revokes every MCP connection of an account; `by` names the action for the audit log. */
  disconnectMcpClients: (userId: string, by: string) => Promise<number>;
}) =>
  ({
    id: "nimbus-security",
    endpoints: {
      revokeSessionById: createAuthEndpoint(
        "/nimbus/revoke-session",
        {
          method: "POST",
          body: z.object({ id: z.string().min(1).max(200) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const current = ctx.context.session;
          const target = await ctx.context.adapter.findOne<{
            token: string;
            userAgent: string | null;
          }>({
            model: "session",
            where: [
              { field: "id", value: ctx.body.id },
              { field: "userId", value: current.user.id },
            ],
          });
          if (!target)
            throw new APIError("NOT_FOUND", {
              message:
                "That session has already ended. Refresh the page to see your current sessions.",
            });
          if (target.token === current.session.token)
            throw new APIError("BAD_REQUEST", {
              message:
                "This is the session you are using now. Use Sign out to end it.",
            });
          await ctx.context.internalAdapter.deleteSession(target.token);
          recordAudit({
            action: "auth.session_revoked",
            actor: auditUser(current.user),
            target: {
              type: "session",
              id: ctx.body.id,
              label: target.userAgent ?? undefined,
            },
          });
          return ctx.json({ revoked: true });
        },
      ),
      resetSecondFactors: createAuthEndpoint(
        "/nimbus/admin/reset-second-factors",
        {
          method: "POST",
          body: z.object({ userId: z.string().min(1).max(200) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const actor = ctx.context.session.user;
          const role = z
            .object({ role: z.string().nullish() })
            .safeParse(actor);
          if (!role.success || !includesAdmin(role.data.role))
            throw new APIError("FORBIDDEN", {
              message:
                "Only server administrators can reset another account's sign-in methods.",
            });
          if (ctx.body.userId === actor.id)
            throw new APIError("BAD_REQUEST", {
              message:
                "Manage your own authenticator and passkeys in Settings, Account.",
            });
          const target = await ctx.context.internalAdapter.findUserById(
            ctx.body.userId,
          );
          if (!target)
            throw new APIError("NOT_FOUND", {
              message: "That account no longer exists. Nothing was changed.",
            });
          const userId = target.id;
          await ctx.context.adapter.deleteMany({
            model: "twoFactor",
            where: [{ field: "userId", value: userId }],
          });
          await ctx.context.adapter.deleteMany({
            model: "passkey",
            where: [{ field: "userId", value: userId }],
          });
          await ctx.context.adapter.deleteMany({
            model: "verification",
            where: [
              {
                field: "identifier",
                value: "trust-device-",
                operator: "starts_with",
              },
              { field: "value", value: userId },
            ],
          });
          await ctx.context.internalAdapter.updateUser(userId, {
            twoFactorEnabled: false,
          });
          await ctx.context.internalAdapter.deleteUserSessions(userId);
          // App passwords are created only from a session, so none can appear once sessions are gone.
          const revoked = await appPasswords.listAppPasswords(userId);
          for (const password of revoked)
            await appPasswords.removeAppPassword(password.id, userId);
          const mcpClientsDisconnected = await disconnectMcpClients(
            userId,
            "sign_in_methods_reset",
          );
          recordAudit({
            action: "account.second_factors_reset",
            actor: auditUser(actor),
            target: { type: "user", id: userId, label: target.email },
            details: {
              appPasswordsRevoked: revoked.length,
              mcpClientsDisconnected,
            },
          });
          return ctx.json({ reset: true });
        },
      ),
    },
    hooks: {
      after: [
        {
          matcher: (context) => (context.path ?? "") in disconnectsMcp,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof APIError) return;
            const by = disconnectsMcp[ctx.path];
            const target = z.object({ userId: z.string() }).safeParse(ctx.body);
            const userId = ctx.path.startsWith("/admin/")
              ? target.success
                ? target.data.userId
                : undefined
              : ctx.context.session?.user.id;
            if (by && userId) await disconnectMcpClients(userId, by);
          }),
        },
        {
          matcher: (context) => context.path === "/two-factor/enable",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = enableResult.safeParse(ctx.context.returned);
            if (!returned.success) return;
            return ctx.json({
              ...returned.data,
              qrCode: totpQrCode(returned.data.totpURI),
            });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
