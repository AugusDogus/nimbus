import { describe, expect, it } from "bun:test";
import { TRPCClientError } from "@trpc/client";
import { SearchProblem } from "./search-problem";

const refused = (code: string) =>
  new TRPCClientError("raw server text", {
    result: {
      error: { code: -32000, message: "raw server text", data: { code } },
    },
  });

describe("SearchProblem", () => {
  it("says a refused or stopped search needs a moment, in its own words", () => {
    const busy = SearchProblem.of(refused("TOO_MANY_REQUESTS"));
    expect(busy.kind).toBe("busy");
    expect(busy.message).toContain("Wait a moment");
    const slow = SearchProblem.of(refused("TIMEOUT"));
    expect(slow.kind).toBe("slow");
    expect(slow.message).toContain("took longer");
  });

  it("passes other failures through", () => {
    expect(SearchProblem.of(new Error("Disk on fire"))).toEqual({
      kind: "failed",
      message: "Disk on fire",
    });
  });
});
