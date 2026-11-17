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

/** The well-formed, unexpired proofs in the request's cookie named `name`, newest first. */
function proofs(name: string, request: Request) {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  return (cookie?.split("~") ?? []).flatMap((proof) => {
    const [expires, received] = proof.split(".");
    return expires &&
      received &&
      /^\d{13}$/.test(expires) &&
      /^[a-f0-9]{64}$/.test(received) &&
      Number(expires) > Date.now()
      ? [{ expires, received }]
      : [];
  });
}

/**
 * The Set-Cookie value proving `scope` for an hour. With `keep`, the cookie also carries up to
 * that many earlier proofs from `request`'s cookie of the same name, so one cookie can prove
 * several things, such as transfers of several files of one link.
 */
function issue(scope: UnlockScope, keep?: { request: Request; count: number }) {
  const expires = String(Date.now() + lifetimeMs);
  const earlier = keep
    ? proofs(scope.name, keep.request)
        .slice(0, keep.count)
        .map((proof) => `${proof.expires}.${proof.received}`)
    : [];
  const value = [`${expires}.${signature(scope, expires)}`, ...earlier].join(
    "~",
  );
  return `${scope.name}=${value}; HttpOnly; SameSite=Lax; Path=${scope.path}; Max-Age=${lifetimeMs / 1000}${secureAttribute}`;
}

function verify(scope: UnlockScope, request: Request) {
  return proofs(scope.name, request).some((proof) =>
    timingSafeEqual(
      Buffer.from(proof.received),
      Buffer.from(signature(scope, proof.expires)),
    ),
  );
}

export const UnlockCookie = { issue, verify, secureAttribute } as const;
