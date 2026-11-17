import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A signed, hour-long proof that a visitor entered a link's password, or
 * already downloaded a file through it. The signature covers `binding`, such
 * as the password hash, so changing or removing it ends every earlier cookie.
 */
export type UnlockScope = {
  /** Cookie name, unique per link. */
  name: string;
  /** Cookie path; the cookie is only sent to these endpoints. */
  path: string;
  token: string;
  /** What the cookie proves something about: the password hash, or a file and its version. */
  binding: string;
};

const lifetimeMs = 60 * 60 * 1000;

function signature(scope: UnlockScope, expires: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error(
      "BETTER_AUTH_SECRET is required for password-protected links. Set it and restart Nimbus.",
    );
  return createHmac("sha256", secret)
    .update(`${scope.token}:${scope.binding}:${expires}`)
    .digest("hex");
}

// Behind a TLS-terminating proxy the request URL is plain HTTP, so use the public origin.
const secureAttribute = (process.env.BETTER_AUTH_URL ?? "").startsWith("https:")
  ? "; Secure"
  : "";

function issue(scope: UnlockScope) {
  const expires = String(Date.now() + lifetimeMs);
  const secure = secureAttribute;
  return `${scope.name}=${expires}.${signature(scope, expires)}; HttpOnly; SameSite=Lax; Path=${scope.path}; Max-Age=${lifetimeMs / 1000}${secure}`;
}

function verify(scope: UnlockScope, request: Request) {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${scope.name}=`))
    ?.slice(scope.name.length + 1);
  const [expires, received] = cookie?.split(".") ?? [];
  if (
    !expires ||
    !received ||
    !/^\d{13}$/.test(expires) ||
    !/^[a-f0-9]{64}$/.test(received) ||
    Number(expires) <= Date.now()
  )
    return false;
  const expected = signature(scope, expires);
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export const UnlockCookie = { issue, verify, secureAttribute } as const;
