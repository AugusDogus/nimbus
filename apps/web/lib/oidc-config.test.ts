import { describe, expect, it } from "bun:test";
import { OidcConfig } from "./oidc-config";

const base = {
  NIMBUS_OIDC_ISSUER: "https://id.example.com/realms/main/",
  NIMBUS_OIDC_CLIENT_ID: "nimbus",
  NIMBUS_OIDC_CLIENT_SECRET: "s3cret-value",
};

describe("OidcConfig.parse", () => {
  it("is off without any variable", () => {
    expect(OidcConfig.parse({})).toEqual({ kind: "disabled" });
  });
  it("links existing accounts only by default", () => {
    const config = OidcConfig.parse(base);
    expect(config).toEqual({
      kind: "oidc",
      issuer: "https://id.example.com/realms/main",
      clientId: "nimbus",
      clientSecret: "s3cret-value",
      label: "single sign-on",
      autoProvision: false,
      groupsClaim: null,
    });
    if (config.kind === "oidc")
      expect(OidcConfig.discoveryUrl(config)).toBe("https://id.example.com/realms/main/.well-known/openid-configuration");
  });
  it.each([
    [{ NIMBUS_OIDC_ISSUER: base.NIMBUS_OIDC_ISSUER }, "NIMBUS_OIDC_CLIENT_ID, NIMBUS_OIDC_CLIENT_SECRET must be set"],
    [{ NIMBUS_OIDC_GROUPS_CLAIM: "groups" }, "NIMBUS_OIDC_ISSUER, NIMBUS_OIDC_CLIENT_ID, NIMBUS_OIDC_CLIENT_SECRET must be set"],
    [{ ...base, NIMBUS_OIDC_ISSUER: "http://id.example.com" }, "must use https"],
    [{ ...base, NIMBUS_OIDC_ISSUER: "not a url" }, "is not a URL"],
    [{ ...base, NIMBUS_OIDC_AUTO_PROVISION: "yes" }, 'NIMBUS_OIDC_AUTO_PROVISION is "yes"'],
  ])("fails with a precise message for %p", (env, message) => {
    expect(() => OidcConfig.parse(env)).toThrow(message);
  });
  it("never includes the client secret in errors", () => {
    expect(() => OidcConfig.parse({ NIMBUS_OIDC_CLIENT_SECRET: "s3cret-value" })).not.toThrow("s3cret");
  });
});

describe("OidcConfig.groups", () => {
  it("accepts arrays and space or comma separated strings", () => {
    expect(OidcConfig.groups({ groups: ["Team", "Ops", 3, "Team"] }, "groups")).toEqual(["Team", "Ops"]);
    expect(OidcConfig.groups({ roles: "Team, Ops" }, "roles")).toEqual(["Team", "Ops"]);
    expect(OidcConfig.groups({}, "groups")).toEqual([]);
  });
});
