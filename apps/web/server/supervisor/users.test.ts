import { expect, test } from "bun:test";
import { Users } from "./users";

const root = { euid: 0, oneUserUpdates: false };

test("started as root with the servers' ids: servers as PUID:PGID, the installer as the update user", () => {
  expect(
    Users.fromEnvironment(
      { NIMBUS_SERVER_UID: "2000", NIMBUS_SERVER_GID: "2001" },
      root,
    ),
  ).toEqual({
    kind: "split",
    server: { uid: 2000, gid: 2001 },
    update: { uid: 1100, gid: 1100 },
    updatesOff: null,
  });
  expect(Users.setpriv).toStartWith("/");
  expect(Users.dropTo({ uid: 2000, gid: 2001 }, ["bun", "start.ts"])).toEqual([
    Users.setpriv,
    "--reuid=2000",
    "--regid=2001",
    "--clear-groups",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--no-new-privs",
    "--",
    "bun",
    "start.ts",
  ]);
});

test("as root, ids that are not canonical numbers in range refuse to start rather than run servers as root", () => {
  for (const value of [
    "",
    "0",
    "-1",
    "02000",
    "2000 ",
    "1e3",
    "4294967295",
    "0x7d0",
  ])
    expect(
      Users.fromEnvironment(
        { NIMBUS_SERVER_UID: value, NIMBUS_SERVER_GID: "2000" },
        root,
      ).kind,
    ).toBe("refused");
  expect(Users.fromEnvironment({}, root).kind).toBe("refused");
});

test("an update user that is not one of its own turns updates off, servers still dropped", () => {
  const users = Users.fromEnvironment(
    {
      NIMBUS_SERVER_UID: "1100",
      NIMBUS_SERVER_GID: "1100",
    },
    root,
  );
  expect(users).toMatchObject({
    kind: "split",
    server: { uid: 1100, gid: 1100 },
    update: null,
  });
  if (users.kind === "split") expect(users.updatesOff).toContain("update user");
});

test("started as another user, as with --user: one user, updates off unless a test asks", () => {
  const single = Users.fromEnvironment(
    { NIMBUS_SERVER_UID: "2000", NIMBUS_SERVER_GID: "2000" },
    { euid: 1000, oneUserUpdates: false },
  );
  expect(single.kind).toBe("single");
  if (single.kind === "single")
    expect(single.updatesOff).toContain("PUID and PGID");
  expect(
    Users.fromEnvironment({}, { euid: 1000, oneUserUpdates: true }),
  ).toEqual({ kind: "single", updatesOff: null });
});
