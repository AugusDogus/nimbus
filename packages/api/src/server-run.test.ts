import { describe, expect, test } from "bun:test";
import { z } from "zod";
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

describe("ServerRun.current", () => {
  test("starts when the server process loads it, not when it is first asked", () => {
    // A link issued between startup and the first upload must not look older than the run.
    const script = `
      const loadedAt = Date.now();
      const { ServerRun } = await import(${JSON.stringify(`${import.meta.dir}/server-run.ts`)});
      await Bun.sleep(200);
      console.log(JSON.stringify({ loadedAt, startedAt: ServerRun.current().startedAt }));
    `;
    const env = { ...process.env };
    delete env.NIMBUS_RUN_ID;
    delete env.NIMBUS_RUN_STARTED_AT;
    const run = Bun.spawnSync([process.execPath, "-e", script], { env });
    const { loadedAt, startedAt } = z
      .object({ loadedAt: z.number(), startedAt: z.number() })
      .parse(JSON.parse(run.stdout.toString()));
    expect(startedAt - loadedAt).toBeLessThan(100);
  });
});
