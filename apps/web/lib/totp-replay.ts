import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { z } from "zod";

/**
 * Better Auth accepts an authenticator code for the previous, current and next 30-second
 * step and keeps no record of codes already used, so one code can complete several
 * sign-ins (better-auth/better-auth#10387). RFC 6238 section 5.2 requires refusing a
 * second use. Better Auth still generates and checks every code; this only remembers
 * each account's accepted codes for the 90 seconds they can be valid, and refuses them
 * again. A code is reserved before verification, so two requests sending it at once
 * cannot both pass, and released when verification fails. The record lives in memory:
 * a restart forgets at most 90 seconds of codes.
 */
const VALID_FOR_MS = 90 * 1000;
const path = "/two-factor/verify-totp";

const codeBody = z.object({ code: z.string() });
const sessionUser = z.object({ user: z.object({ id: z.string() }) });

export const totpReplayGuard = () => {
  /** Accepted or in-flight codes per account, by key, with when they stop mattering. */
  const used = new Map<string, number>();
  /** The key each in-flight request reserved, released if its verification fails. */
  const reserved = new WeakMap<Request, string>();

  /** The account being verified: the signed-in session, or the sign-in challenge's. */
  const accountOf = async (
    ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  ) => {
    const session = sessionUser.safeParse(await getSessionFromCtx(ctx));
    if (session.success) return session.data.user.id;
    const challenge = await ctx.getSignedCookie(
      ctx.context.createAuthCookie("two_factor").name,
      ctx.context.secret,
    );
    if (!challenge) return null;
    const verification =
      await ctx.context.internalAdapter.findVerificationValue(challenge);
    return verification?.value ?? null;
  };

  return {
    id: "nimbus-totp-replay",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === path,
          handler: createAuthMiddleware(async (ctx) => {
            const body = codeBody.safeParse(ctx.body);
            if (!body.success || !ctx.request) return;
            const account = await accountOf(ctx);
            if (account === null) return;
            const key = createHash("sha256")
              .update(`${account}:${body.data.code.replace(/\s/g, "")}`)
              .digest("base64url");
            const now = Date.now();
            for (const [entry, expires] of used)
              if (expires <= now) used.delete(entry);
            // Checked and reserved without awaiting, so parallel requests see each other.
            if ((used.get(key) ?? 0) > now)
              throw new APIError("UNAUTHORIZED", {
                code: "TOTP_ALREADY_USED",
                message:
                  "That code was already used. Wait for your authenticator app to show a new code, then enter it.",
              });
            used.set(key, now + VALID_FOR_MS);
            reserved.set(ctx.request, key);
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === path,
          handler: createAuthMiddleware(async (ctx) => {
            const key = ctx.request && reserved.get(ctx.request);
            if (key && ctx.context.returned instanceof APIError)
              used.delete(key);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
