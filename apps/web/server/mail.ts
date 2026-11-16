/**
 * Outgoing email for password recovery. Disabled unless NIMBUS_SMTP_HOST and NIMBUS_SMTP_FROM are set.
 * Every setting is validated at startup so a half-configured server fails loudly
 * instead of silently dropping recovery messages.
 */
export type MailConfig =
  | { kind: "disabled" }
  | {
      kind: "smtp";
      host: string;
      port: number;
      security: "starttls" | "tls" | "plain";
      auth: { user: string; pass: string } | null;
      from: string;
    };

const variables = [
  "NIMBUS_SMTP_HOST",
  "NIMBUS_SMTP_PORT",
  "NIMBUS_SMTP_SECURITY",
  "NIMBUS_SMTP_USER",
  "NIMBUS_SMTP_PASSWORD",
  "NIMBUS_SMTP_FROM",
] as const;
type MailEnvironment = Readonly<Record<string, string | undefined>>;

const fail = (problem: string): never => {
  throw new Error(
    `SMTP email is partly configured: ${problem} Password recovery email stays off until this is fixed. Set the NIMBUS_SMTP_* variables described in the README, or remove all of them to disable email.`,
  );
};

export const MailConfig = {
  parse(env: MailEnvironment): MailConfig {
    const present = variables.filter(
      (name) => env[name] !== undefined && env[name] !== "",
    );
    if (present.length === 0) return { kind: "disabled" };
    const missing = (["NIMBUS_SMTP_HOST", "NIMBUS_SMTP_FROM"] as const).filter(
      (name) => !env[name],
    );
    if (missing.length > 0)
      fail(
        `${missing.join(" and ")} must be set when ${present.join(", ")} is set.`,
      );
    for (const name of present)
      if (/[\r\n]/.test(env[name] ?? ""))
        fail(`${name} must not contain line breaks.`);
    const host = (env.NIMBUS_SMTP_HOST ?? "").trim();
    if (!/^[A-Za-z0-9.:[\]-]+$/.test(host))
      fail(`NIMBUS_SMTP_HOST "${host}" is not a host name or IP address.`);
    const security = env.NIMBUS_SMTP_SECURITY ?? "starttls";
    if (security !== "starttls" && security !== "tls" && security !== "plain")
      fail(
        `NIMBUS_SMTP_SECURITY is "${security}". Use starttls, tls, or plain.`,
      );
    const portText =
      env.NIMBUS_SMTP_PORT ?? (security === "tls" ? "465" : "587");
    const port = Number(portText);
    if (!/^\d+$/.test(portText) || port < 1 || port > 65535)
      fail(`NIMBUS_SMTP_PORT is "${portText}". Use a number from 1 to 65535.`);
    const user = env.NIMBUS_SMTP_USER ?? "";
    const pass = env.NIMBUS_SMTP_PASSWORD ?? "";
    if ((user === "") !== (pass === ""))
      fail(
        "set both NIMBUS_SMTP_USER and NIMBUS_SMTP_PASSWORD, or neither for an unauthenticated relay.",
      );
    const from = (env.NIMBUS_SMTP_FROM ?? "").trim();
    if (!/^(?:[^<>@]*<[^<>\s@]+@[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+)$/.test(from))
      fail(
        `NIMBUS_SMTP_FROM "${from}" is not a single address such as "Nimbus <nimbus@example.com>".`,
      );
    return {
      kind: "smtp",
      host,
      port,
      security:
        security === "tls" || security === "plain" ? security : "starttls",
      auth: user ? { user, pass } : null,
      from,
    };
  },
} as const;

export const mailConfig = MailConfig.parse(process.env);

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

type Transport = { sendMail(message: object): Promise<unknown> };
let transport: Promise<Transport> | undefined;

/** Sends one message. Nodemailer loads on first use so startup does not pay for it. */
export async function sendMail(message: MailMessage): Promise<void> {
  if (mailConfig.kind === "disabled")
    throw new Error(
      "sendMail was called while SMTP email is disabled. Check mailConfig.kind before sending.",
    );
  const config = mailConfig;
  transport ??= import("nodemailer").then(({ default: nodemailer }) =>
    nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.security === "tls",
      requireTLS: config.security === "starttls",
      ignoreTLS: config.security === "plain",
      ...(config.auth && { auth: config.auth }),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    }),
  );
  await (await transport).sendMail({ from: config.from, ...message });
}
