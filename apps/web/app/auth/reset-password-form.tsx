import { Link } from "@/components/link";
import { useState } from "react";
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
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string }
  | { kind: "sent" }
  | { kind: "reset" };

export function ResetPasswordForm({
  token,
  expired,
}: {
  token: string | null;
  expired: boolean;
}) {
  const [state, setState] = useState<State>(
    expired
      ? {
          kind: "error",
          message:
            "That reset link has expired or was already used. Request a new one below.",
        }
      : { kind: "idle" },
  );
  const busy = state.kind === "busy";
  const message =
    state.kind === "error" ? (
      <FieldDescription
        role="alert"
        className="text-pretty text-center text-red-600 dark:text-red-400"
      >
        {state.message}
      </FieldDescription>
    ) : null;

  if (token && !expired)
    return (
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-balance text-xl">
            <h1>Choose a new password</h1>
          </CardTitle>
          <CardDescription className="text-pretty">
            Resetting your password signs out every session. WebDAV app
            passwords stay active.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.kind === "reset" ? (
            <div className="space-y-4 text-center">
              <p role="status" className="text-pretty text-sm">
                Your password has been changed.
              </p>
              <Button
                nativeButton={false}
                className="w-full"
                render={<Link to="/login" />}
              >
                Sign in
              </Button>
            </div>
          ) : (
            <form
              onSubmit={(event) =>
                void (async () => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  const newPassword = values.get("newPassword");
                  if (typeof newPassword !== "string") return;
                  if (newPassword !== values.get("confirmPassword")) {
                    setState({
                      kind: "error",
                      message: "The new passwords do not match.",
                    });
                    return;
                  }
                  setState({ kind: "busy" });
                  const result = await authClient
                    .resetPassword({ newPassword, token })
                    .catch(() => null);
                  if (!result)
                    setState({
                      kind: "error",
                      message:
                        "The server could not be reached. Your password is unchanged. Try again.",
                    });
                  else if (result.error)
                    setState({
                      kind: "error",
                      message:
                        result.error.code === "INVALID_TOKEN"
                          ? "That reset link has expired or was already used. Request a new one."
                          : (result.error.message ??
                            "Your password could not be changed. Try again."),
                    });
                  else setState({ kind: "reset" });
                })()
              }
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="new-password">New password</FieldLabel>
                  <Input
                    id="new-password"
                    name="newPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={128}
                    required
                    disabled={busy}
                  />
                  <FieldDescription>
                    Use at least 8 characters.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="confirm-password">
                    Confirm new password
                  </FieldLabel>
                  <Input
                    id="confirm-password"
                    name="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    minLength={8}
                    maxLength={128}
                    required
                    disabled={busy}
                  />
                </Field>
                <Field>
                  <Button type="submit" disabled={busy}>
                    {busy ? "Saving…" : "Change password"}
                  </Button>
                  {message}
                </Field>
              </FieldGroup>
            </form>
          )}
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-balance text-xl">
          <h1>Reset your password</h1>
        </CardTitle>
        <CardDescription className="text-pretty">
          Enter your account email and Nimbus will send you a link to choose a
          new password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.kind === "sent" ? (
          <div className="space-y-4 text-center">
            <p role="status" className="text-pretty text-sm">
              If an account uses that address, a reset link is on its way. It
              works for one hour. Check your spam folder if it does not arrive.
            </p>
            <Button
              nativeButton={false}
              variant="outline"
              className="w-full"
              render={<Link to="/login" />}
            >
              Back to sign in
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(event) =>
              void (async () => {
                event.preventDefault();
                const email = new FormData(event.currentTarget).get("email");
                if (typeof email !== "string") return;
                setState({ kind: "busy" });
                const result = await authClient
                  .requestPasswordReset({
                    email,
                    redirectTo: "/reset-password",
                  })
                  .catch(() => null);
                if (!result)
                  setState({
                    kind: "error",
                    message: "The server could not be reached. Try again.",
                  });
                else if (result.error)
                  setState({
                    kind: "error",
                    message:
                      result.error.message ??
                      "The reset email could not be requested. Try again later.",
                  });
                else setState({ kind: "sent" });
              })()
            }
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  disabled={busy}
                />
              </Field>
              <Field>
                <Button type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Send reset link"}
                </Button>
                {message}
                <FieldDescription className="text-center">
                  <Link to="/login" className="underline underline-offset-4">
                    Back to sign in
                  </Link>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
