/**
 * Ending the session through the auth server's own endpoint, which needs no code loaded on
 * demand, so a page opened before Nimbus was updated still signs out.
 */
export type SignOut =
  | { kind: "signed-out" }
  | { kind: "refused"; status: number }
  | { kind: "unreachable" };

/**
 * Whether `response` is the auth server's confirmation: JSON with `success: true`. Anything else,
 * such as a proxy's sign-in page answered with 200, leaves the session as it was.
 */
async function confirmed(response: Response) {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.startsWith("application/json")
  )
    return false;
  const body: unknown = await response.json().catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "success" in body &&
    body.success === true
  );
}

export const SignOut = {
  confirmed,

  async request(): Promise<SignOut> {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => null);
    if (!response) return { kind: "unreachable" };
    return (await confirmed(response))
      ? { kind: "signed-out" }
      : { kind: "refused", status: response.status };
  },
} as const;
