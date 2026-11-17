import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { openTestDrive, type TestDrive } from "./drive-testing";

/**
 * Access is cached per account until the store's access epoch changes. The in-memory test
 * store changes its epoch on every read, so only the SQLite store, whose triggers move the
 * epoch, shows a cache that misses a change. Every request below goes through the procedures
 * and their cache, as the browser's do.
 */
describe("cached access after sharing changes", () => {
  let drive: TestDrive;
  beforeEach(async () => {
    drive = await openTestDrive();
    await drive.write("team/plan.txt", "plan");
    await mkdir(drive.absolute("archive"));
  });
  afterEach(async () => {
    await drive.close();
  });

  const canList = async (path: string) => {
    try {
      await drive.caller("carol").files.list({ path });
      return true;
    } catch {
      return false;
    }
  };

  test("grants and revocations apply on the next request", async () => {
    expect(await canList("team")).toBe(false);
    await drive.caller("owner").access.grant({
      path: "team",
      subject: { type: "user", id: "carol" },
      permission: "read",
    });
    expect(await canList("team")).toBe(true);
    const [grant] = await drive.caller("owner").access.permissions({
      path: "team",
    });
    if (!grant) throw new Error("The grant was not saved.");
    await drive.caller("owner").access.revoke({ path: "team", id: grant.id });
    expect(await canList("team")).toBe(false);
  });

  test("group membership and group removal apply on the next request", async () => {
    await drive.caller("owner").access.saveGroup({
      name: "Team",
      memberIds: ["carol"],
    });
    const [group] = await drive.caller("owner").access.groups();
    if (!group) throw new Error("The group was not saved.");
    await drive.caller("owner").access.grant({
      path: "team",
      subject: { type: "group", id: group.id },
      permission: "read",
    });
    expect(await canList("team")).toBe(true);
    await drive.caller("owner").access.saveGroup({
      id: group.id,
      name: "Team",
      memberIds: [],
    });
    expect(await canList("team")).toBe(false);
    await drive.caller("owner").access.saveGroup({
      id: group.id,
      name: "Team",
      memberIds: ["carol"],
    });
    expect(await canList("team")).toBe(true);
    await drive.caller("owner").access.removeGroup({ id: group.id });
    expect(await canList("team")).toBe(false);
  });

  test("moves, trash and restore of a shared folder apply on the next request", async () => {
    await drive.grant("team", "carol", "read");
    expect(await canList("team")).toBe(true);
    await drive
      .caller("owner")
      .files.move({ sourcePath: "team", destinationPath: "archive" });
    expect(await canList("archive/team")).toBe(true);
    expect(await canList("archive")).toBe(true);
    const { trashId } = await drive
      .caller("owner")
      .files.delete({ path: "archive/team" });
    // The folder is gone, and so is the browse path that led to it.
    expect(await canList("archive")).toBe(false);
    await drive.caller("owner").trash.restore({ id: trashId });
    expect(await canList("archive/team")).toBe(true);
  });

  test("a disabled account is refused on its next request", async () => {
    await drive.grant("team", "carol", "read");
    expect(await canList("team")).toBe(true);
    drive.sqlite.run("UPDATE user SET banned = 1 WHERE id = 'carol'");
    await expect(
      drive.caller("carol").files.list({ path: "team" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
