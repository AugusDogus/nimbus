import { ShareResult } from "./share-result";

/** What the server sends with a public share page: the link and its first answer. */
export type SharePageData = { token: string; result: ShareResult };

export const SharePageData = {
  parse(value: unknown): SharePageData | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const token = "token" in value ? value.token : undefined;
    const result = ShareResult.parse("result" in value ? value.result : null);
    return typeof token === "string" && result ? { token, result } : undefined;
  },
} as const;
