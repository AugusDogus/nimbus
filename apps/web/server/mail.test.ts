import { describe, expect, it } from "bun:test";
import { MailConfig } from "./mail";

describe("MailConfig.parse", () => {
  it("is disabled when no SMTP variable is set", () => {
    expect(MailConfig.parse({})).toEqual({ kind: "disabled" });
  });
  it("defaults to required STARTTLS on port 587", () => {
    expect(MailConfig.parse({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "Nimbus <nimbus@example.com>" })).toEqual({
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
      MailConfig.parse({ SMTP_HOST: "mail.local", SMTP_FROM: "a@b.test", SMTP_SECURITY: "tls", SMTP_USER: "u", SMTP_PASSWORD: " p " }),
    ).toMatchObject({ port: 465, auth: { user: "u", pass: " p " } });
  });
  it.each([
    [{ SMTP_HOST: "smtp.example.com" }, "SMTP_FROM must be set"],
    [{ SMTP_PASSWORD: "secret" }, "SMTP_HOST and SMTP_FROM must be set"],
    [{ SMTP_HOST: "h", SMTP_FROM: "a@b.test", SMTP_USER: "u" }, "set both SMTP_USER and SMTP_PASSWORD"],
    [{ SMTP_HOST: "h", SMTP_FROM: "a@b.test", SMTP_PORT: "70000" }, 'SMTP_PORT is "70000"'],
    [{ SMTP_HOST: "h", SMTP_FROM: "a@b.test", SMTP_SECURITY: "ssl" }, 'SMTP_SECURITY is "ssl"'],
    [{ SMTP_HOST: "h", SMTP_FROM: "a@b.test\r\nBcc: x@y.test" }, "SMTP_FROM must not contain line breaks"],
    [{ SMTP_HOST: "h", SMTP_FROM: "one@a.test, two@b.test" }, "is not a single address"],
  ])("fails with a precise message for %p", (env, message) => {
    expect(() => MailConfig.parse(env)).toThrow(message);
  });
  it("never includes the password in errors", () => {
    expect(() => MailConfig.parse({ SMTP_HOST: "h", SMTP_PASSWORD: "hunter2-secret" })).not.toThrow("hunter2");
  });
});
