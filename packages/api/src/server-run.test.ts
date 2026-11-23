import { describe, expect, test } from "bun:test";
import { ServerRun } from "./server-run";

describe("ServerRun.fromEnvironment", () => {
  test("starts a run of its own when the supervisor names none", () => {
    const first = ServerRun.fromEnvironment({}, 5_000);
    const second = ServerRun.fromEnvironment({}, 5_000);
    if (!first.ok || !second.ok) throw new Error("expected runs");
    expect(first.run.startedAt).toBe(5_000);
    expect(first.run.id).not.toBe(second.run.id);
  });

  test("keeps the supervisor's run, so every server it starts shares it", () => {
    const env = {
      NIMBUS_RUN_ID: "run-0123456789abcdef",
      NIMBUS_RUN_STARTED_AT: "4000",
    };
    expect(ServerRun.fromEnvironment(env, 5_000)).toEqual({
      ok: true,
      run: { id: "run-0123456789abcdef", startedAt: 4_000 },
    });
  });

  test("refuses half a run, a malformed id and a start in the future", () => {
    for (const env of [
      { NIMBUS_RUN_ID: "run-0123456789abcdef" },
      { NIMBUS_RUN_STARTED_AT: "4000" },
      { NIMBUS_RUN_ID: "short", NIMBUS_RUN_STARTED_AT: "4000" },
      { NIMBUS_RUN_ID: "run 0123456789abcdef", NIMBUS_RUN_STARTED_AT: "4000" },
      { NIMBUS_RUN_ID: "run-0123456789abcdef", NIMBUS_RUN_STARTED_AT: "soon" },
      { NIMBUS_RUN_ID: "run-0123456789abcdef", NIMBUS_RUN_STARTED_AT: "6000" },
    ]) {
      const parsed = ServerRun.fromEnvironment(env, 5_000);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.kind).toBe("invalid-run");
    }
  });
});
