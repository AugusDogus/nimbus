const plural = (count: number, unit: string) =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

/** The wait a throttled reply (429) asks for. */
export const RetryAfter = {
  /**
   * How long to wait, in words, from `Retry-After` or Better Auth's `X-Retry-After` (seconds):
   * seconds under a minute, whole minutes rounded up above, "a moment" without a usable value.
   */
  wait(response: Response): string {
    const seconds = Math.ceil(
      Number(
        response.headers.get("retry-after") ??
          response.headers.get("x-retry-after"),
      ),
    );
    if (!(seconds > 0)) return "a moment";
    return seconds < 60
      ? plural(seconds, "second")
      : plural(Math.ceil(seconds / 60), "minute");
  },
} as const;
