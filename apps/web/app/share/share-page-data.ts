import { ShareResult } from "./share-result";

/** What the server sends with a public share page: the link and its first answer. */
export type SharePageData = { token: string; result: ShareResult };

export const sharePageElementId = "nimbus-share";

export const SharePageData = {
  /**
   * JSON for an inline `<script type="application/json">`. Escaping `<` keeps the data from
   * closing the element, and the line separators are escaped for older parsers.
   */
  serialize(value: SharePageData): string {
    return JSON.stringify(value)
      .replaceAll("<", "\\u003c")
      .replaceAll(" ", "\\u2028")
      .replaceAll(" ", "\\u2029");
  },
  parse(text: string): SharePageData | undefined {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const token = "token" in value ? value.token : undefined;
    const result = ShareResult.parse("result" in value ? value.result : null);
    return typeof token === "string" && result ? { token, result } : undefined;
  },
} as const;
