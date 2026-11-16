/**
 * Single sign-on through one OpenID Connect provider. Off unless NIMBUS_OIDC_ISSUER is set.
 *
 * Provisioning rule: registration stays closed. A provider identity signs in only when
 * a Nimbus account already uses the same email and the provider reports that email as
 * verified. NIMBUS_OIDC_AUTO_PROVISION=true lets unknown identities create ordinary
 * member accounts, which start with no file access.
 */
export type OidcConfig =
  | { kind: "disabled" }
  | {
      kind: "oidc";
      issuer: string;
      clientId: string;
      clientSecret: string;
      label: string;
      autoProvision: boolean;
      groupsClaim: string | null;
    };

type OidcEnvironment = Readonly<Record<string, string | undefined>>;

const variables = [
  "NIMBUS_OIDC_ISSUER",
  "NIMBUS_OIDC_CLIENT_ID",
  "NIMBUS_OIDC_CLIENT_SECRET",
  "NIMBUS_OIDC_NAME",
  "NIMBUS_OIDC_AUTO_PROVISION",
  "NIMBUS_OIDC_GROUPS_CLAIM",
] as const;

const fail = (problem: string): never => {
  throw new Error(
    `Single sign-on is partly configured: ${problem} Nimbus did not start, and no accounts were changed. Set the NIMBUS_OIDC_* variables described in the README, or remove all of them to turn single sign-on off.`,
  );
};

export const oidcProviderId = "oidc";

export const OidcConfig = {
  parse(env: OidcEnvironment): OidcConfig {
    const present = variables.filter((name) => env[name]);
    if (present.length === 0) return { kind: "disabled" };
    const required = [
      "NIMBUS_OIDC_ISSUER",
      "NIMBUS_OIDC_CLIENT_ID",
      "NIMBUS_OIDC_CLIENT_SECRET",
    ] as const;
    const missing = required.filter((name) => !env[name]);
    if (missing.length > 0)
      fail(
        `${missing.join(", ")} must be set when ${present.join(", ")} is set.`,
      );
    let issuer: URL;
    try {
      issuer = new URL(env.NIMBUS_OIDC_ISSUER ?? "");
    } catch {
      return fail(
        `NIMBUS_OIDC_ISSUER "${env.NIMBUS_OIDC_ISSUER}" is not a URL. Use the issuer from your provider, such as https://id.example.com/realms/main.`,
      );
    }
    if (
      issuer.protocol !== "https:" &&
      issuer.hostname !== "localhost" &&
      issuer.hostname !== "127.0.0.1"
    )
      fail(`NIMBUS_OIDC_ISSUER must use https, except for localhost testing.`);
    if (issuer.search || issuer.hash)
      fail("NIMBUS_OIDC_ISSUER must not include a query string or fragment.");
    const provision = env.NIMBUS_OIDC_AUTO_PROVISION ?? "false";
    if (provision !== "true" && provision !== "false")
      fail(`NIMBUS_OIDC_AUTO_PROVISION is "${provision}". Use true or false.`);
    const claim = env.NIMBUS_OIDC_GROUPS_CLAIM?.trim() || null;
    if (claim !== null && !/^[A-Za-z0-9_:./-]{1,100}$/.test(claim))
      fail(`NIMBUS_OIDC_GROUPS_CLAIM "${claim}" is not a claim name.`);
    return {
      kind: "oidc",
      issuer: issuer.href.replace(/\/$/, ""),
      clientId: env.NIMBUS_OIDC_CLIENT_ID ?? "",
      clientSecret: env.NIMBUS_OIDC_CLIENT_SECRET ?? "",
      label: env.NIMBUS_OIDC_NAME?.trim() || "single sign-on",
      autoProvision: provision === "true",
      groupsClaim: claim,
    };
  },
  discoveryUrl(config: Extract<OidcConfig, { kind: "oidc" }>) {
    return `${config.issuer}/.well-known/openid-configuration`;
  },
  /** Reads a groups claim from verified ID token claims. Non-string entries are ignored. */
  groups(claims: Record<string, unknown>, claim: string): string[] {
    const value = claims[claim];
    const list = Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(/[\s,]+/)
        : [];
    return [
      ...new Set(
        list.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length > 0,
        ),
      ),
    ];
  },
} as const;

export const oidcConfig = OidcConfig.parse(process.env);
