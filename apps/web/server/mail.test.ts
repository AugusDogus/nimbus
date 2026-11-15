import { describe, expect, it } from "bun:test";
import { MailConfig } from "./mail";

describe("MailConfig.parse", () => {
  it("is disabled when no SMTP variable is set", () => {
    expect(MailConfig.parse({})).toEqual({ kind: "disabled" });
  });
  it("defaults to required STARTTLS on port 587", () => {
    expect(MailConfig.parse({ NIMBUS_SMTP_HOST: "smtp.example.com", NIMBUS_SMTP_FROM: "Nimbus <nimbus@example.com>" })).toEqual({
      kind: "smtp",
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      auth: null,
      from: "Nimbus <nimbus@example.com>",
    });
  });
  it("uses port 465 for implicit TLS and keeps password whitespace", () => {
    expect(
      MailConfig.parse({ NIMBUS_SMTP_HOST: "mail.local", NIMBUS_SMTP_FROM: "a@b.test", NIMBUS_SMTP_SECURITY: "tls", NIMBUS_SMTP_USER: "u", NIMBUS_SMTP_PASSWORD: " p " }),
    ).toMatchObject({ port: 465, auth: { user: "u", pass: " p " } });
  });
  it.each([
    [{ NIMBUS_SMTP_HOST: "smtp.example.com" }, "NIMBUS_SMTP_FROM must be set"],
    [{ NIMBUS_SMTP_PASSWORD: "secret" }, "NIMBUS_SMTP_HOST and NIMBUS_SMTP_FROM must be set"],
    [{ NIMBUS_SMTP_HOST: "h", NIMBUS_SMTP_FROM: "a@b.test", NIMBUS_SMTP_USER: "u" }, "set both NIMBUS_SMTP_USER and NIMBUS_SMTP_PASSWORD"],
    [{ NIMBUS_SMTP_HOST: "h", NIMBUS_SMTP_FROM: "a@b.test", NIMBUS_SMTP_PORT: "70000" }, 'NIMBUS_SMTP_PORT is "70000"'],
    [{ NIMBUS_SMTP_HOST: "h", NIMBUS_SMTP_FROM: "a@b.test", NIMBUS_SMTP_SECURITY: "ssl" }, 'NIMBUS_SMTP_SECURITY is "ssl"'],
    [{ NIMBUS_SMTP_HOST: "h", NIMBUS_SMTP_FROM: "a@b.test\r\nBcc: x@y.test" }, "NIMBUS_SMTP_FROM must not contain line breaks"],
    [{ NIMBUS_SMTP_HOST: "h", NIMBUS_SMTP_FROM: "one@a.test, two@b.test" }, "is not a single address"],
  ])("fails with a precise message for %p", (env, message) => {
    expect(() => MailConfig.parse(env)).toThrow(message);
  });
  it("never includes the password in errors", () => {
    expect(() => MailConfig.parse({ NIMBUS_SMTP_HOST: "h", NIMBUS_SMTP_PASSWORD: "hunter2-secret" })).not.toThrow("hunter2");
  });
});
