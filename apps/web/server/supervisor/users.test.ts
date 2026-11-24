import { expect, test } from "bun:test";
import { Users } from "./users";

const status = (effective: string) => `Name:\tbun\nCapEff:\t${effective}\n`;

test("split: the entrypoint named the servers' user and left the supervisor the rights to switch to it and signal it", () => {
  const users = Users.fromEnvironment(
    { NIMBUS_SERVER_UID: "2000", NIMBUS_SERVER_GID: "2001" },
    { uid: 1100, status: status("00000000000000e0") },
  );
  expect(users.kind).toBe("split");
  expect(users.server(["bun", "server/start.ts"])).toEqual([
    "setpriv",
    "--reuid=2000",
    "--regid=2001",
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    "bun",
    "server/start.ts",
  ]);
  expect(users.unprivileged(["bun", "installer.ts"])).toEqual([
    "setpriv",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--",
    "bun",
    "installer.ts",
  ]);
  expect(users.updatesOff).toBeNull();
});

test("one user, as under --user, or without the rights to switch and signal: updates are off and say how to turn them on", () => {
  for (const [environment, effective] of [
    [{}, "0000000000000000"],
    [
      { NIMBUS_SERVER_UID: "2000", NIMBUS_SERVER_GID: "2000" },
      "0000000000000000",
    ],
    [
      { NIMBUS_SERVER_UID: "1100", NIMBUS_SERVER_GID: "2000" },
      "00000000000000e0",
    ],
    // Able to switch to the servers' user but not to stop its servers.
    [
      { NIMBUS_SERVER_UID: "2000", NIMBUS_SERVER_GID: "2000" },
      "00000000000000c0",
    ],
  ] as const) {
    const users = Users.fromEnvironment(environment, {
      uid: 1100,
      status: status(effective),
    });
    expect(users.kind).toBe("single");
    expect(users.server(["bun", "server/start.ts"])).toEqual([
      "bun",
      "server/start.ts",
    ]);
    expect(users.updatesOff).toContain("PUID and PGID");
  }
});

test("updates with one user only when asked to, for development and tests", () => {
  const users = Users.fromEnvironment(
    { NIMBUS_UPDATES_WITH_ONE_USER: "1" },
    { uid: 1000, status: status("0000000000000000") },
  );
  expect(users.kind).toBe("single");
  expect(users.updatesOff).toBeNull();
});
