import { expect, test } from "bun:test";
import { Credentials } from "./credentials";

const status = ({
  uid = "2000\t2000\t2000\t2000",
  gid = "2001\t2001\t2001\t2001",
  groups = "",
  effective = "0000000000000000",
  bounding = "0000000000000000",
  noNewPrivs = "1",
} = {}) =>
  [
    "Name:\tbun",
    `Uid:\t${uid}`,
    `Gid:\t${gid}`,
    `Groups:\t${groups}`,
    "CapInh:\t0000000000000000",
    "CapPrm:\t0000000000000000",
    `CapEff:\t${effective}`,
    `CapBnd:\t${bounding}`,
    "CapAmb:\t0000000000000000",
    `NoNewPrivs:\t${noNewPrivs}`,
  ].join("\n");

const ids = { uid: 2000, gid: 2001 };
const check = (text: string) =>
  Credentials.dropped(Credentials.parse(text), ids);

test("a child dropped to its ids with nothing more passes", () => {
  expect(check(status())).toBeNull();
});

test("any other id, group, capability or a missing no_new_privs fails, and says which", () => {
  expect(check(status({ uid: "2000\t0\t2000\t2000" }))).toContain("users");
  expect(check(status({ gid: "2001\t2001\t0\t2001" }))).toContain("groups");
  expect(check(status({ groups: "0 27" }))).toContain("supplementary");
  expect(check(status({ effective: "00000000000000c0" }))).toContain(
    "effective",
  );
  expect(check(status({ bounding: "000001ffffffffff" }))).toContain("bounding");
  expect(check(status({ noNewPrivs: "0" }))).toContain("no_new_privs");
  expect(Credentials.dropped(Credentials.parse("Name:\tbun\n"), ids)).toContain(
    "could not be read",
  );
});

test("a child setpriv is still dropping is judged only once it has dropped everything", async () => {
  // As setpriv goes: still root, then the user set (keeping capabilities), then the groups,
  // the bounding set and, at exec, the rest.
  const steps = [
    status({ uid: "0\t0\t0\t0", gid: "0\t0\t0\t0" }),
    status({ gid: "0\t0\t0\t0", effective: "00000000000001e0" }),
    status({ effective: "00000000000001e0", bounding: "00000000000001e0" }),
    status(),
  ];
  let looks = 0;
  const look = async () => Credentials.parse(steps[looks++] ?? status());
  expect(
    await Credentials.untilDropped(1, ids, {
      running: () => true,
      intervalMs: 0,
      look,
    }),
  ).toBeNull();
  expect(looks).toBe(steps.length);
});

test("a child that never drops everything is refused with what the last look saw", async () => {
  const mixed = Credentials.parse(status({ effective: "00000000000001e0" }));
  expect(
    await Credentials.untilDropped(1, ids, {
      running: () => true,
      intervalMs: 0,
      look: async () => mixed,
    }),
  ).toContain("effective");
  expect(
    await Credentials.untilDropped(1, ids, {
      running: () => false,
      intervalMs: 0,
      look: async () => mixed,
    }),
  ).toBe("it did not start");
});

test("this process is found among its user's processes", async () => {
  const uid = process.getuid?.() ?? 0;
  expect(await Credentials.processesOf(uid)).toContain(process.pid);
  const own = await Credentials.read(process.pid);
  expect(own?.uids).toEqual([uid, uid, uid, uid]);
});
