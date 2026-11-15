"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient, signIn } from "@/lib/auth-client";
import { queryClient } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const getErrorMessage = (error: unknown) => {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
  }

  return "Something went wrong. Please try again.";
};

const twoFactorChallenge = z.object({ twoFactorRedirect: z.literal(true) });

type Step =
  | { kind: "credentials" }
  | { kind: "second-factor"; method: "totp" | "recovery" };

const finish = () => {
  queryClient.clear();
  window.location.assign("/");
};

const isAbort = (error: unknown) =>
  error instanceof DOMException && (error.name === "AbortError" || error.name === "NotAllowedError");

export function LoginForm({
  setupAvailable = false,
  singleSignOn = null,
  passwordReset = false,
  initialError = null,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  setupAvailable?: boolean;
  /** Label of the configured identity provider, or null when single sign-on is off. */
  singleSignOn?: string | null;
  /** Whether forgotten passwords can be reset by email. */
  passwordReset?: boolean;
  initialError?: string | null;
}) {
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // Offer saved passkeys in the email field's autofill. The WebAuthn helpers load
    // only when the browser supports it, after the page is interactive.
    let active = true;
    const supported = window.PublicKeyCredential?.isConditionalMediationAvailable?.();
    void supported?.then(async (available) => {
      if (!available || !active) return;
      const { passkeyAuthClient } = await import("@/lib/passkey-client");
      if (!active) return;
      const result = await passkeyAuthClient.signIn.passkey({ autoFill: true }).catch(() => null);
      if (active && result && !result.error) finish();
    });
    return () => {
      active = false;
    };
  }, []);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);
    try {
      await action();
    } catch (err) {
      if (!isAbort(err)) setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCredentials = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email || !password) {
      setError("Enter an email and password to continue.");
      return;
    }
    void run(async () => {
      const result = await signIn.email({ email, password });
      if (result?.error) {
        setError(getErrorMessage(result.error));
        return;
      }
      if (twoFactorChallenge.safeParse(result.data).success) {
        setPassword("");
        setStep({ kind: "second-factor", method: "totp" });
        return;
      }
      setSuccess("Signed in successfully.");
      finish();
    });
  };

  const handleSecondFactor = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step.kind !== "second-factor") return;
    const method = step.method;
    void run(async () => {
      const { securityClient } = await import("@/lib/security-client");
      const result =
        method === "totp"
          ? await securityClient.twoFactor.verifyTotp({ code: code.trim(), trustDevice })
          : await securityClient.twoFactor.verifyBackupCode({ code: code.trim(), trustDevice });
      if (result.error) {
        setError(
          result.error.code === "INVALID_TWO_FACTOR_COOKIE"
            ? "This sign-in attempt expired. Enter your email and password again."
            : getErrorMessage(result.error),
        );
        if (result.error.code === "INVALID_TWO_FACTOR_COOKIE") setStep({ kind: "credentials" });
        return;
      }
      setSuccess("Signed in successfully.");
      finish();
    });
  };

  const signInWithPasskey = () =>
    run(async () => {
      const { passkeyAuthClient } = await import("@/lib/passkey-client");
      const result = await passkeyAuthClient.signIn.passkey();
      if (result?.error) {
        setError(
          getErrorMessage(result.error) ||
            "Your passkey was not accepted. Try again, or sign in with your password.",
        );
        return;
      }
      finish();
    });

  const signInWithProvider = () =>
    run(async () => {
      const result = await authClient.signIn.social({
        provider: "oidc",
        callbackURL: "/",
        errorCallbackURL: "/login",
      });
      if (result.error) setError(getErrorMessage(result.error));
    });

  if (step.kind === "second-factor")
    return (
      <div className={cn("flex flex-col gap-6", className)} {...props}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-balance text-xl">
              {step.method === "totp" ? "Enter your code" : "Use a recovery code"}
            </CardTitle>
            <CardDescription className="text-pretty">
              {step.method === "totp"
                ? "Open your authenticator app and enter the 6-digit code for Nimbus."
                : "Enter one of the recovery codes you saved when you set up two-factor authentication. Each code works once."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSecondFactor}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="second-factor-code">
                    {step.method === "totp" ? "Authentication code" : "Recovery code"}
                  </FieldLabel>
                  <Input
                    id="second-factor-code"
                    autoComplete="one-time-code"
                    inputMode={step.method === "totp" ? "numeric" : "text"}
                    pattern={step.method === "totp" ? "[0-9 ]{6,7}" : undefined}
                    maxLength={step.method === "totp" ? 7 : 64}
                    autoFocus
                    spellCheck={false}
                    value={code}
                    onChange={(event) => {
                      setCode(event.target.value);
                      setError(null);
                    }}
                    required
                    className="font-mono tracking-widest"
                  />
                </Field>
                <label className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 rounded accent-primary"
                    checked={trustDevice}
                    onChange={(event) => setTrustDevice(event.target.checked)}
                  />
                  Trust this browser for 30 days
                </label>
                <Field>
                  <Button type="submit" disabled={!code.trim() || isSubmitting}>
                    {isSubmitting ? "Verifying…" : "Verify"}
                  </Button>
                  {error ? (
                    <FieldDescription role="alert" className="text-pretty text-center text-red-600 dark:text-red-400">
                      {error}
                    </FieldDescription>
                  ) : null}
                  {success ? (
                    <FieldDescription role="status" className="text-pretty text-center text-emerald-600 dark:text-emerald-400">
                      {success}
                    </FieldDescription>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setCode("");
                      setError(null);
                      setStep({
                        kind: "second-factor",
                        method: step.method === "totp" ? "recovery" : "totp",
                      });
                    }}
                  >
                    {step.method === "totp" ? "Use a recovery code instead" : "Use your authenticator app instead"}
                  </Button>
                  <Button type="button" variant="ghost" disabled={isSubmitting} onClick={() => void signInWithPasskey()}>
                    Use a passkey instead
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    );

  const isDisabled = !email || !password || isSubmitting;

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-balance text-xl">Welcome back</CardTitle>
          <CardDescription className="text-pretty">
            Use your email and password to sign in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCredentials}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  autoComplete="username webauthn"
                  type="email"
                  placeholder="m@example.com"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setError(null);
                  }}
                  required
                />
              </Field>
              <Field>
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  {passwordReset && (
                    <Link
                      href="/reset-password"
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      Forgot password?
                    </Link>
                  )}
                </div>
                <Input
                  id="password"
                  autoComplete="current-password"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setError(null);
                  }}
                  required
                />
                <FieldDescription className="text-pretty">
                  {passwordReset
                    ? "Use the password for your Nimbus account."
                    : "Use the password for your Nimbus account. If you forgot it, ask your server administrator to reset it."}
                </FieldDescription>
              </Field>
              <Field>
                <Button type="submit" disabled={isDisabled}>
                  Sign in
                </Button>
                {error ? (
                  <FieldDescription role="alert" className="text-pretty text-center text-red-600 dark:text-red-400">
                    {error}
                  </FieldDescription>
                ) : null}
                {success ? (
                  <FieldDescription role="status" className="text-pretty text-center text-emerald-600 dark:text-emerald-400">
                    {success}
                  </FieldDescription>
                ) : null}
              </Field>
              <FieldSeparator className="*:data-[slot=field-separator-content]:bg-card">
                Or
              </FieldSeparator>
              <Field>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => void signInWithPasskey()}
                >
                  Sign in with a passkey
                </Button>
                {singleSignOn && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSubmitting}
                    onClick={() => void signInWithProvider()}
                  >
                    Continue with {singleSignOn}
                  </Button>
                )}
                <FieldDescription className="text-pretty text-center">
                  {setupAvailable ? (
                    <Link
                      className="underline underline-offset-4"
                      href="/signup"
                    >
                      Set up your server
                    </Link>
                  ) : (
                    "Need an account? Ask your server administrator."
                  )}
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
