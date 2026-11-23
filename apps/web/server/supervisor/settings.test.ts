import { describe, expect, test } from "bun:test";
import { defaultSocketPath, parseSettings } from "./settings";
import { Supervision } from "./supervision";
import type { WorkerMessage } from "./protocol";

describe("parseSettings", () => {
  test("defaults let a film begun before an update play to its end", () => {
    expect(parseSettings({})).toEqual({
      ok: true,
      value: {
        drainMs: 6 * 60 * 60 * 1000,
        maxDraining: 2,
        readyTimeoutMs: 300_000,
        stopMs: 30_000,
        killGraceMs: 10_000,
        restartMs: { initial: 1_000, max: 30_000 },
        releasesDir: null,
        socketPath: defaultSocketPath,
      },
    });
  });

  test("reads each setting", () => {
    const parsed = parseSettings({
      NIMBUS_DRAIN_HOURS: "0.5",
      NIMBUS_MAX_DRAINING: "4",
      NIMBUS_READY_TIMEOUT_SECONDS: "60",
      NIMBUS_STOP_SECONDS: "20",
      NIMBUS_RELEASES_DIR: "/config/releases",
      NIMBUS_SUPERVISOR_SOCKET: "/run/nimbus/control.sock",
    });
    expect(parsed.ok && parsed.value).toMatchObject({
      drainMs: 30 * 60 * 1000,
      maxDraining: 4,
      readyTimeoutMs: 60_000,
      stopMs: 20_000,
      releasesDir: "/config/releases",
      socketPath: "/run/nimbus/control.sock",
    });
  });

  test("names every invalid setting at once", () => {
    const parsed = parseSettings({
      NIMBUS_DRAIN_HOURS: "forever",
      NIMBUS_MAX_DRAINING: "1.5",
      NIMBUS_STOP_SECONDS: "0",
      NIMBUS_SUPERVISOR_SOCKET: "control.sock",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.messages.map((message) => message.split(" ")[0])).toEqual([
        "NIMBUS_DRAIN_HOURS",
        "NIMBUS_MAX_DRAINING",
        "NIMBUS_STOP_SECONDS",
        "NIMBUS_SUPERVISOR_SOCKET",
      ]);
  });
});

describe("Supervision", () => {
  test("is standalone without the supervisor's protocol variable", () => {
    expect(Supervision.fromProcess({})).toEqual({
      ok: true,
      value: { kind: "standalone" },
    });
  });

  test("refuses a supervisor that speaks another protocol", () => {
    const parsed = Supervision.fromProcess({
      NIMBUS_SUPERVISOR_PROTOCOL: "999",
      NIMBUS_RELEASE: "a",
    });
    expect(parsed.ok).toBe(false);
  });

  test("asks the supervisor for scopes and releases them once, after the grant", async () => {
    const sent: WorkerMessage[] = [];
    const remote = Supervision.remoteScopes(
      (message) => void sent.push(message),
    );
    const acquiring = remote.authority.acquire([
      { space: "drive", path: "docs" },
    ]);
    expect(sent).toEqual([
      {
        kind: "acquire-scopes",
        id: 1,
        scopes: [{ space: "drive", path: "docs" }],
      },
    ]);
    remote.granted(1);
    const release = await acquiring;
    release();
    release();
    expect(sent.slice(1)).toEqual([{ kind: "release-scopes", id: 1 }]);
    // A grant for something never asked is ignored.
    remote.granted(42);
    expect(sent).toHaveLength(2);
  });
});
