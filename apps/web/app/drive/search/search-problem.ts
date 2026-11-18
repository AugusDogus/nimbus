import { trpcErrorCode } from "@/lib/trpc-error";

/**
 * Why a search has no answer. `busy` and `slow` are the server pacing searches (a few at once
 * per person, a deadline for each), which a moment's wait fixes; `failed` is anything else.
 */
export type SearchProblem = {
  kind: "busy" | "slow" | "failed";
  message: string;
};

export const SearchProblem = {
  of(error: unknown): SearchProblem {
    switch (trpcErrorCode(error)) {
      case "TOO_MANY_REQUESTS":
        return {
          kind: "busy",
          message:
            "Nimbus is still answering your earlier searches. Wait a moment, then search again.",
        };
      case "TIMEOUT":
        return {
          kind: "slow",
          message:
            "This search took longer than Nimbus allows, so it was stopped. Search again, or add words to narrow it.",
        };
      default:
        return {
          kind: "failed",
          message:
            error instanceof Error && error.message
              ? error.message
              : "The search failed. Your files are unchanged; search again.",
        };
    }
  },
} as const;
