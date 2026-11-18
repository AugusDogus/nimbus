import * as z from "zod/mini";
import { RetryAfter } from "./retry-after";

const errorSchema = z.object({ error: z.string() });

/** Unlocking a password-protected public link: a share or an upload link. */
export const LinkUnlock = {
  /**
   * What to tell a visitor whose unlock request failed. A throttled attempt (429) never checked
   * the password, so it says how long to wait, from `Retry-After`, instead of the server's
   * minute-rounded text. Otherwise the server's reason, or `fallback` for a reply without one.
   */
  async failure(response: Response, fallback: string): Promise<string> {
    if (response.status === 429)
      return `Too many password attempts on this link. Wait ${RetryAfter.wait(response)}, then try again. Your password was not checked.`;
    const body = errorSchema.safeParse(await response.json().catch(() => null));
    return body.success ? body.data.error : fallback;
  },
} as const;
