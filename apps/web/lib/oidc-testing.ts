import { generateKeyPairSync, sign } from "node:crypto";
import type { OidcConfig } from "./oidc-config";

export type IdentityClaims = {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  groups?: string[];
};

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

/**
 * A minimal OpenID Connect provider for tests: discovery, JWKS, and a token endpoint that
 * signs an RS256 ID token for whatever identity the test set with `signInAs`.
 */
export function startMockOidcProvider() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: "test",
    alg: "RS256",
    use: "sig",
  };
  const clientId = "nimbus-test-client";
  let identity: IdentityClaims | null = null;
  /** The nonce of the latest authorization request, which the ID token must echo. */
  let nonce: string | undefined;

  const idToken = (claims: Record<string, unknown>) => {
    const header = base64url(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test" }),
    );
    const payload = base64url(JSON.stringify(claims));
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      privateKey,
    );
    return `${header}.${payload}.${base64url(signature)}`;
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request): Response {
      const url = new URL(request.url);
      const issuer = url.origin;
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["RS256"],
        });
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/token" && request.method === "POST") {
        if (!identity)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          access_token: "provider-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken({
            iss: issuer,
            aud: clientId,
            iat: now,
            exp: now + 300,
            ...(nonce !== undefined && { nonce }),
            ...identity,
          }),
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const issuer = `http://127.0.0.1:${server.port}`;
  return {
    clientId,
    issuer,
    config(
      settings: { autoProvision?: boolean; groupsClaim?: string | null } = {},
    ): OidcConfig {
      return {
        kind: "oidc",
        issuer,
        clientId,
        clientSecret: "test-client-secret",
        label: "Test SSO",
        autoProvision: settings.autoProvision ?? false,
        groupsClaim: settings.groupsClaim ?? null,
      };
    },
    /** The identity the next token request returns, and the nonce its ID token carries. */
    signInAs(claims: IdentityClaims, requestNonce: string | undefined) {
      identity = claims;
      nonce = requestNonce;
    },
    /** A validly signed ID token for `claims`, as the provider would issue it. */
    idToken(claims: IdentityClaims & { nonce?: string }) {
      const now = Math.floor(Date.now() / 1000);
      return idToken({
        iss: issuer,
        aud: clientId,
        iat: now,
        exp: now + 300,
        ...claims,
      });
    },
    stop() {
      void server.stop(true);
    },
  };
}
