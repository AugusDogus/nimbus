"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import type { FormEvent } from "react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card"
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { signIn } from "@/lib/auth-client"
import { cn } from "@/lib/utils"

const getErrorMessage = (error: unknown) => {
  if (typeof error === "string") {
    return error
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = error.message
    if (typeof message === "string") {
      return message
    }
  }

  return "Something went wrong. Please try again."
}

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const router = useRouter()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSuccess(null)

    if (!email || !password) {
      setError("Enter an email and password to continue.")
      return
    }

    setIsSubmitting(true)
    try {
      const result = await signIn.email({ email, password })
      if (result?.error) {
        setError(getErrorMessage(result.error))
        return
      }
      setSuccess("Signed in successfully.")
      router.push("/")
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const isDisabled = !email || !password || isSubmitting

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
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  placeholder="m@example.com"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setError(null)
                  }}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value)
                    setError(null)
                  }}
                  required
                />
                <FieldDescription className="text-pretty">
                  Passwords are hashed and never stored in plaintext.
                </FieldDescription>
              </Field>
              <Field>
                <Button type="submit" disabled={isDisabled}>
                  Sign in
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
                  Don&apos;t have an account?{" "}
                  <Link className="underline-offset-4 hover:underline" href="/signup">
                    Sign up
                  </Link>
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
