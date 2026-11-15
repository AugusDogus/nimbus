import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import {
  auditUser,
  recordAudit,
  type AuditAction,
  type AuditActor,
  type AuditDetails,
} from "@nimbus/api/audit";

const body = z
  .object({
    email: z.string().max(320).optional(),
    userId: z.string().max(200).optional(),
    role: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .passthrough();
const userShape = z.object({ id: z.string(), email: z.string() });
const sessionShape = z.object({ user: userShape });

/** Sign-in endpoints and the method each represents. */
const signIns: Record<string, string> = {
  "/sign-in/email": "password",
  "/two-factor/verify-totp": "password+totp",
  "/two-factor/verify-backup-code": "password+recovery_code",
  "/passkey/verify-authentication": "passkey",
};

/** Endpoints whose success is recorded as one action, attributed to the signed-in caller. */
const actions: Record<string, AuditAction> = {
  "/change-password": "auth.password_changed",
  "/reset-password": "auth.password_reset",
  "/two-factor/disable": "auth.two_factor_disabled",
  "/two-factor/generate-backup-codes": "auth.recovery_codes_regenerated",
  "/passkey/verify-registration": "auth.passkey_added",
  "/passkey/delete-passkey": "auth.passkey_removed",
  "/revoke-other-sessions": "auth.sessions_revoked",
  "/revoke-sessions": "auth.sessions_revoked",
  "/sign-up/email": "account.created",
  "/admin/create-user": "account.created",
  "/admin/update-user": "account.updated",
  "/admin/set-role": "account.role_changed",
  "/admin/ban-user": "account.disabled",
  "/admin/unban-user": "account.enabled",
  "/admin/remove-user": "account.removed",
  "/admin/set-user-password": "account.password_set",
  "/admin/revoke-user-sessions": "account.sessions_revoked",
};

const errorCode = (error: APIError) => {
  const parsed = z.object({ code: z.string() }).safeParse(error.body);
  return parsed.success ? parsed.data.code : String(error.status);
};

/**
 * Records Better Auth activity in the Nimbus audit log. Keep it after every other
 * plugin so it observes final results (for example, after two-factor has replaced a
 * provisional session with a challenge). Never records passwords, codes or tokens.
 */
export const nimbusAudit = () =>
  ({
    id: "nimbus-audit",
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const returned: unknown = ctx.context.returned;
            const failed = returned instanceof APIError && returned.status !== "FOUND";
            const input = body.safeParse(ctx.body);
            const email = input.success ? input.data.email?.toLowerCase() : undefined;
            const caller = sessionShape.safeParse(ctx.context.session);
            const actor: AuditActor = caller.success
              ? auditUser(caller.data.user)
              : { type: "anonymous", ...(email && { label: email }) };
            const path = ctx.path.startsWith("/callback/") ? "oidc" : ctx.path;
            // Confirming a new authenticator also calls verify-totp, from a signed-in session.
            const method = path === "oidc" ? "oidc" : caller.success ? undefined : signIns[path];
            if (method) {
              const created = sessionShape.safeParse(ctx.context.newSession);
              if (created.success)
                recordAudit({ action: "auth.sign_in", actor: auditUser(created.data.user), details: { method } });
              else if (failed)
                recordAudit({
                  action: "auth.sign_in_failed",
                  actor,
                  details: { method, reason: errorCode(returned) },
                });
              else if (path === "oidc") {
                const location = ctx.context.responseHeaders?.get("location");
                const reason = location ? new URL(location, "http://local").searchParams.get("error") : null;
                if (reason) recordAudit({ action: "auth.sign_in_failed", actor, details: { method, reason } });
              }
              return;
            }
            if (path === "/request-password-reset" && !failed) {
              recordAudit({ action: "auth.password_reset_requested", actor });
              return;
            }
            const action = actions[path];
            if (!action || failed) return;
            const details: AuditDetails = {};
            if (input.success && input.data.role !== undefined)
              details.role = [input.data.role].flat().join(",");
            const userId = input.success ? input.data.userId : undefined;
            const createdUser = z.object({ user: userShape }).safeParse(returned);
            const target =
              userId !== undefined
                ? { type: "user" as const, id: userId }
                : action === "account.created" && createdUser.success
                  ? { type: "user" as const, id: createdUser.data.user.id, label: createdUser.data.user.email }
                  : undefined;
            recordAudit({
              action,
              actor,
              ...(target && { target }),
              ...(Object.keys(details).length > 0 && { details }),
            });
          }),
        },
      ],
    },
    onResponse: async (response) => {
      if (response.status === 429)
        recordAudit({ action: "auth.rate_limited", actor: { type: "anonymous" }, details: { service: "auth" } });
      return { response };
    },
  }) satisfies BetterAuthPlugin;
