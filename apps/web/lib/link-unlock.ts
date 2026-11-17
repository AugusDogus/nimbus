import * as z from "zod/mini";

const errorSchema = z.object({ error: z.string() });

const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

/** Unlocking a password-protected public link: a share or an upload link. */
export const LinkUnlock = {
  /**
   * What to tell a visitor whose unlock request failed. A throttled attempt (429) never checked
   * the password, so it says how long to wait, from `Retry-After`, instead of the server's
   * minute-rounded text. Otherwise the server's reason, or `fallback` for a reply without one.
   */
  async failure(response: Response, fallback: string): Promise<string> {
    if (response.status === 429) {
      const seconds = Math.ceil(Number(response.headers.get("retry-after")));
      const wait = !(seconds > 0)
        ? "a moment"
        : seconds < 60
          ? plural(seconds, "second")
          : plural(Math.ceil(seconds / 60), "minute");
      return `Too many password attempts on this link. Wait ${wait}, then try again. Your password was not checked.`;
    }
    const body = errorSchema.safeParse(await response.json().catch(() => null));
    return body.success ? body.data.error : fallback;
  },
} as const;
