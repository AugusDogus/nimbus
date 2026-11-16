import { FileRequestResult } from "./file-request-result";

/** What the server sends with an upload page: the link and its first answer. */
export type FileRequestPageData = { token: string; result: FileRequestResult };

export const FileRequestPageData = {
  parse(value: unknown): FileRequestPageData | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const token = "token" in value ? value.token : undefined;
    const result = FileRequestResult.parse(
      "result" in value ? value.result : null,
    );
    return typeof token === "string" && result ? { token, result } : undefined;
  },
} as const;
