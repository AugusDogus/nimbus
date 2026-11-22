import type { SubmitEvent } from "react";
import { useEffect, useRef, useState } from "react";
import * as z from "zod/mini";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { CodeLoad } from "@/lib/code-load";
import { CallbackUrl } from "@/lib/callback-url";
import { RetryAfter } from "@/lib/retry-after";
import { useHydrated } from "@/lib/use-hydrated";
import { useServerField } from "@/lib/use-server-field";
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

let finished = false;

/**
 * Every sign-in path ends here, returning to `redirectTo`, a validated same-origin path. It
 * loads a new page, so nothing from before signing in carries over. Only the first call
 * navigates: a second would abort the first page load.
 */
const finish = (redirectTo: string) => {
  if (finished) return;
  finished = true;
  window.location.assign(redirectTo);
};

/** The email field's passkey autofill request, while it may still be running. */
type Autofill = {
  /** Settles when the request has ended: whether it signed in. */
  ended: Promise<boolean>;
};

/**
 * Ends the autofill request before another passkey ceremony starts, and says whether it
 * signed in meanwhile. Starting a ceremony cancels any other one in flight, so an autofill
 * request still fetching its options would cancel the button's ceremony once it starts.
 * Cancelling until it has ended closes that gap; it settles within one options request.
 */
async function endAutofill(
  autofill: Autofill | null,
  ceremonies: { cancelCeremony: () => void },
) {
  if (!autofill) return false;
  let ended = false;
  void autofill.ended.then(() => {
    ended = true;
  });
  // No deadline: giving up early would let a slow autofill request cancel the button's
  // ceremony after all. The autofill request ends once its options request does.
  while (!ended) {
    ceremonies.cancelCeremony();
    await Promise.race([
      autofill.ended,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
  }
  return autofill.ended;
}

const isAbort = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "AbortError" || error.name === "NotAllowedError");

export function LoginForm({
  setupAvailable = false,
  singleSignOn = null,
  passwordReset = false,
  initialError = null,
  redirectTo = CallbackUrl.DEFAULT,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  setupAvailable?: boolean;
  /** Label of the configured identity provider, or null when single sign-on is off. */
  singleSignOn?: string | null;
  /** Whether forgotten passwords can be reset by email. */
  passwordReset?: boolean;
  initialError?: string | null;
  /** A validated same-origin path, such as an MCP consent page. */
  redirectTo?: string;
}) {
  const [step, setStep] = useState<Step>({ kind: "credentials" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const emailField = useServerField(setEmail);
  const passwordField = useServerField(setPassword);
  const hydrated = useHydrated();
  // `autoFocus` does not reach an input that mounts after this page hydrates, so the code
  // field is focused when its step appears, including after switching to a recovery code.
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (step.kind === "second-factor") codeInput.current?.focus();
  }, [step]);

  const autofill = useRef<Autofill | null>(null);
  /** Counts autofill requests; a new one starts after a passkey ceremony from a button ends. */
  const [autofillRound, setAutofillRound] = useState(0);

  useEffect(() => {
    // Offer saved passkeys in the email field's autofill. The WebAuthn helpers load
    // only when the browser supports it, after the page is interactive.
    let active = true;
    const ended = (async () => {
      const available =
        await window.PublicKeyCredential?.isConditionalMediationAvailable?.();
      if (!available || !active) return false;
      const { passkeyAuthClient } = await CodeLoad.load(
        () => import("@/lib/passkey-client"),
      );
      if (!active) return false;
      const result = await passkeyAuthClient.signIn
        .passkey({ autoFill: true })
        .catch(() => null);
      // A passkey chosen here signs in even if a button ceremony asked it to end.
      if (!result || result.error) return false;
      finish(redirectTo);
      return true;
    })().catch(() => false);
    const current: Autofill = { ended };
    autofill.current = current;
    return () => {
      active = false;
      if (autofill.current === current) autofill.current = null;
    };
  }, [redirectTo, autofillRound]);

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

  const handleCredentials = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email || !password) {
      setError("Enter an email and password to continue.");
      return;
    }
    void run(async () => {
      const reply: { throttled: Response | null } = { throttled: null };
      const result = await signIn.email(
        { email, password },
        {
          onError: ({ response }) => {
            if (response.status === 429) reply.throttled = response;
          },
        },
      );
      if (result?.error) {
        // A throttled attempt never reached the password check: say how long to wait instead.
        setError(
          reply.throttled
            ? `Too many sign-in attempts. Wait ${RetryAfter.wait(reply.throttled)}, then try again, or sign in with a passkey. Your password was not checked, and your account is not locked.`
            : getErrorMessage(result.error),
        );
        return;
      }
      if (twoFactorChallenge.safeParse(result.data).success) {
        setPassword("");
        setStep({ kind: "second-factor", method: "totp" });
        return;
      }
      setSuccess("Signed in successfully.");
      finish(redirectTo);
    });
  };

  const handleSecondFactor = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step.kind !== "second-factor") return;
    const method = step.method;
    void run(async () => {
      const { securityClient } = await CodeLoad.load(
        () => import("@/lib/security-client"),
      );
      const result =
        method === "totp"
          ? await securityClient.twoFactor.verifyTotp({
              code: code.trim(),
              trustDevice,
            })
          : await securityClient.twoFactor.verifyBackupCode({
              code: code.trim(),
              trustDevice,
            });
      if (result.error) {
        setError(
          result.error.code === "INVALID_TWO_FACTOR_COOKIE"
            ? "This sign-in attempt expired. Enter your email and password again."
            : getErrorMessage(result.error),
        );
        if (result.error.code === "INVALID_TWO_FACTOR_COOKIE")
          setStep({ kind: "credentials" });
        return;
      }
      setSuccess("Signed in successfully.");
      finish(redirectTo);
    });
  };

  const signInWithPasskey = () =>
    run(async () => {
      const { passkeyAuthClient, WebAuthnAbortService } = await CodeLoad.load(
        () => import("@/lib/passkey-client"),
      );
      const signedIn = await endAutofill(
        autofill.current,
        WebAuthnAbortService,
      );
      if (signedIn) return;
      // Offer autofill again unless this ceremony signs in.
      const offerAutofill = () => setAutofillRound((round) => round + 1);
      const result = await passkeyAuthClient.signIn
        .passkey()
        .catch((error: unknown) => {
          offerAutofill();
          throw error;
        });
      if (result?.error) {
        offerAutofill();
        setError(
          getErrorMessage(result.error) ||
            "Your passkey was not accepted. Try again, or sign in with your password.",
        );
        return;
      }
      finish(redirectTo);
    });

  const signInWithProvider = () =>
    run(async () => {
      const result = await authClient.signIn.social({
        provider: "oidc",
        callbackURL: redirectTo,
        // Errors return here with the same destination, so a retry still ends there.
        errorCallbackURL:
          redirectTo === CallbackUrl.DEFAULT
            ? "/login"
            : `/login?${new URLSearchParams({ callbackURL: redirectTo })}`,
      });
      if (result.error) setError(getErrorMessage(result.error));
    });

  if (step.kind === "second-factor")
    return (
      <div className={cn("flex flex-col gap-6", className)} {...props}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-balance text-xl">
              <h1>
                {step.method === "totp"
                  ? "Enter your code"
                  : "Use a recovery code"}
              </h1>
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
                    {step.method === "totp"
                      ? "Authentication code"
                      : "Recovery code"}
                  </FieldLabel>
                  <Input
                    id="second-factor-code"
                    autoComplete="one-time-code"
                    inputMode={step.method === "totp" ? "numeric" : "text"}
                    pattern={step.method === "totp" ? "[0-9 ]{6,7}" : undefined}
                    maxLength={step.method === "totp" ? 7 : 64}
                    ref={codeInput}
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
                  <Checkbox
                    checked={trustDevice}
                    onCheckedChange={setTrustDevice}
                  />
                  Trust this browser for 30 days
                </label>
                <Field>
                  <Button type="submit" disabled={!code.trim() || isSubmitting}>
                    {isSubmitting ? "Verifying…" : "Verify"}
                  </Button>
                  {error ? (
                    <FieldDescription
                      role="alert"
                      className="text-pretty text-center text-red-600 dark:text-red-400"
                    >
                      {error}
                    </FieldDescription>
                  ) : null}
                  {success ? (
                    <FieldDescription
                      role="status"
                      className="text-pretty text-center text-emerald-600 dark:text-emerald-400"
                    >
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
                    {step.method === "totp"
                      ? "Use a recovery code instead"
                      : "Use your authenticator app instead"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={isSubmitting}
                    onClick={() => void signInWithPasskey()}
                  >
                    Use a passkey instead
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    );

  const isDisabled = !hydrated || !email || !password || isSubmitting;

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-balance text-xl">
            <h1>Welcome back</h1>
          </CardTitle>
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
                  ref={emailField}
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
                    <a
                      href="/reset-password"
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      Forgot password?
                    </a>
                  )}
                </div>
                <Input
                  ref={passwordField}
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
                  <FieldDescription
                    role="alert"
                    className="text-pretty text-center text-red-600 dark:text-red-400"
                  >
                    {error}
                  </FieldDescription>
                ) : null}
                {success ? (
                  <FieldDescription
                    role="status"
                    className="text-pretty text-center text-emerald-600 dark:text-emerald-400"
                  >
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
                  disabled={!hydrated || isSubmitting}
                  onClick={() => void signInWithPasskey()}
                >
                  Sign in with a passkey
                </Button>
                {singleSignOn && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!hydrated || isSubmitting}
                    onClick={() => void signInWithProvider()}
                  >
                    Continue with {singleSignOn}
                  </Button>
                )}
                <FieldDescription className="text-pretty text-center">
                  {setupAvailable ? (
                    <a className="underline underline-offset-4" href="/signup">
                      Set up your server
                    </a>
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
