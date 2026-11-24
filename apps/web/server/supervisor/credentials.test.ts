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

test("this process is found among its user's processes", async () => {
  const uid = process.getuid?.() ?? 0;
  expect(await Credentials.processesOf(uid)).toContain(process.pid);
  const own = await Credentials.read(process.pid);
  expect(own?.uids).toEqual([uid, uid, uid, uid]);
});
