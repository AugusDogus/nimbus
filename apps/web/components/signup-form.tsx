"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
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
import { signIn, signUp } from "@/lib/auth-client";
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

export function SignupForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!name || !email || !password || !confirmPassword) {
      setError("Fill out all fields to continue.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await signUp.email({ email, password, name });
      if (result?.error) {
        setError(getErrorMessage(result.error));
        return;
      }
      setSuccess("Account created. Signing you in...");
      const signInResult = await signIn.email({ email, password });
      if (signInResult?.error) {
        setError(getErrorMessage(signInResult.error));
        return;
      }
      router.push("/");
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const isDisabled =
    !name || !email || !password || !confirmPassword || isSubmitting;

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-balance text-xl">Set up Nimbus</CardTitle>
          <CardDescription className="text-pretty">
            Create the administrator account for this server. You can add other
            users after signing in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="name">Full Name</FieldLabel>
                <Input
                  id="name"
                  autoComplete="name"
                  type="text"
                  placeholder="John Doe"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  autoComplete="email"
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
                <Field className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Input
                      id="password"
                      autoComplete="new-password"
                      minLength={8}
                      type="password"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setError(null);
                      }}
                      required
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="confirm-password">
                      Confirm Password
                    </FieldLabel>
                    <Input
                      id="confirm-password"
                      autoComplete="new-password"
                      minLength={8}
                      type="password"
                      value={confirmPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        setError(null);
                      }}
                      required
                    />
                  </Field>
                </Field>
                <FieldDescription className="text-pretty">
                  Use at least 8 characters.
                </FieldDescription>
              </Field>
              <Field>
                <Button type="submit" disabled={isDisabled}>
                  Create account
                </Button>
                {error ? (
                  <FieldDescription className="text-pretty text-center text-red-600 dark:text-red-400">
                    {error}
                  </FieldDescription>
                ) : null}
                {success ? (
                  <FieldDescription className="text-pretty text-center text-emerald-600 dark:text-emerald-400">
                    {success}
                  </FieldDescription>
                ) : null}
                <FieldDescription className="text-center">
                  Already have an account?{" "}
                  <Link
                    className="underline-offset-4 hover:underline"
                    href="/login"
                  >
                    Sign in
                  </Link>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
