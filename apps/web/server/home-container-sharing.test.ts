import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rename } from "node:fs/promises";
import {
  flushAudit,
  resetAuditForTest,
  setAuditSink,
  type RecordedAuditEvent,
} from "@nimbus/api/audit";
import { HomesExposureError } from "@nimbus/api/home-container-sharing";
import { Homes } from "@nimbus/api/homes";
import { McpScope } from "@nimbus/api/mcp-scope";
import type { McpToolContext } from "@nimbus/api/mcp-tool";
import { mcpTools } from "@nimbus/api/mcp-tools";
import {
  openTestDrive,
  type TestAccount,
  type TestDrive,
} from "./drive-testing";

/**
 * Sharing the folder that holds every home folder, or a folder above it, reaches every home.
 * It is refused unless an administrator allows it, and then needs an explicit acknowledgement.
 * Every request below goes through the tRPC procedures or the MCP tools over the SQLite store.
 */
describe("sharing the home folders container", () => {
  let drive: TestDrive;
  let previousHomes: string | undefined;
  let audit: RecordedAuditEvent[];
  beforeEach(async () => {
    previousHomes = process.env.NIMBUS_HOMES_PATH;
    delete process.env.NIMBUS_HOMES_PATH;
    drive = await openTestDrive();
    expect(await Homes.prepare(drive.store)).toMatchObject({ kind: "ready" });
    await Homes.backfill(drive.store);
    await mkdir(drive.absolute("docs"));
    resetAuditForTest();
    audit = [];
    setAuditSink(async (events) => void audit.push(...events));
  });
  afterEach(async () => {
    resetAuditForTest();
    await drive.close();
    if (previousHomes === undefined) delete process.env.NIMBUS_HOMES_PATH;
    else process.env.NIMBUS_HOMES_PATH = previousHomes;
  });

  const grant = (
    path: string,
    acknowledge?: boolean,
    as: TestAccount = "owner",
  ) =>
    drive.caller(as).access.grant({
      path,
      subject: { type: "user", id: "carol" },
      permission: "read",
      ...(acknowledge === undefined
        ? {}
        : { acknowledgeAllHomeFolders: acknowledge }),
    });
  const link = (path: string, acknowledge?: boolean) =>
    drive.caller("owner").shares.create({
      path,
      expiresAt: null,
      ...(acknowledge === undefined
        ? {}
        : { acknowledgeAllHomeFolders: acknowledge }),
    });
  const uploadLink = (path: string, acknowledge?: boolean) =>
    drive.caller("owner").fileRequests.create({
      path,
      expiresAt: null,
      note: null,
      maxFileBytes: null,
      maxFiles: null,
      maxTotalBytes: null,
      ...(acknowledge === undefined
        ? {}
        : { acknowledgeAllHomeFolders: acknowledge }),
    });
  const allow = (allowed: boolean) =>
    drive
      .caller("owner", "browser")
      .access.setHomeContainerSharing({ allowed });
  const sharingCount = () => ({
    grants: drive.sqlite
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM nimbus_grant WHERE subject_id = 'carol' AND path NOT IN (SELECT path FROM nimbus_home WHERE user_id = 'carol')",
      )
      .get()?.n,
    links: drive.sqlite
      .query<{ n: number }, []>("SELECT count(*) AS n FROM nimbus_share")
      .get()?.n,
    uploadLinks: drive.sqlite
      .query<{ n: number }, []>("SELECT count(*) AS n FROM nimbus_file_request")
      .get()?.n,
  });
  const nothingShared = { grants: 0, links: 0, uploadLinks: 0 };

  test("by default no grant, public link or upload link covers the container, for administrators too", async () => {
    // On a case-insensitive volume these spellings name the container itself.
    await mkdir(drive.absolute("USERS"));
    await mkdir(drive.absolute("Users"));
    for (const path of ["users", "", "USERS", "Users"])
      for (const attempt of [grant, link, uploadLink]) {
        const error = await attempt(path).then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(HomesExposureError);
        expect(error).toMatchObject({ code: "FORBIDDEN" });
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("every user's home folder");
        expect(message).toContain("4 home folders");
        expect(message).toContain("Nothing was changed");
        expect(message).toContain("Share individual folders instead");
        expect(message).toContain("Allow sharing the home folders container");
      }
    expect(sharingCount()).toEqual(nothingShared);
  });

  test("sharing a home folder, a folder inside one, or another folder stays allowed", async () => {
    await mkdir(drive.absolute("users/alice/trips"));
    for (const path of ["users/alice", "users/alice/trips", "docs"]) {
      await grant(path);
      await link(path);
      await uploadLink(path);
    }
    expect(sharingCount()).toEqual({ grants: 3, links: 3, uploadLinks: 3 });
  });

  test("a folder above a nested container is refused, and so is a container from before NIMBUS_HOMES_PATH changed", async () => {
    process.env.NIMBUS_HOMES_PATH = "team/people";
    expect(await Homes.prepare(drive.store)).toMatchObject({ kind: "ready" });
    for (const path of ["team", "team/people", "users"])
      await expect(grant(path)).rejects.toBeInstanceOf(HomesExposureError);
    await mkdir(drive.absolute("team/notes"));
    await grant("team/notes");
    expect(sharingCount().grants).toBe(1);
  });

  test("with sharing allowed, covering the container needs an explicit acknowledgement", async () => {
    await allow(true);
    for (const attempt of [grant, link, uploadLink]) {
      for (const acknowledge of [undefined, false]) {
        const error = await attempt("users", acknowledge).then(
          () => null,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(HomesExposureError);
        expect(error).toMatchObject({ code: "PRECONDITION_FAILED" });
        const message = error instanceof Error ? error.message : "";
        expect(message).toContain("4 home folders");
        expect(message).toContain("acknowledgeAllHomeFolders");
        expect(message).toContain("Nothing was changed");
      }
      await attempt("users", true);
    }
    expect(sharingCount()).toEqual({ grants: 1, links: 1, uploadLinks: 1 });
  });

  test("MCP tools refuse the container, and need the acknowledgement parameter once it is allowed", async () => {
    const context: McpToolContext = {
      userId: "owner",
      scopes: McpScope.all,
      drive: drive.store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
      origin: "https://files.example.test",
      downloadLink: async () => ({
        url: "https://files.example.test/d",
        expiresAt: 0,
      }),
    };
    const call = (name: string, input: Record<string, unknown>) => {
      const tool = mcpTools.find((entry) => entry.name === name);
      if (!tool) throw new Error(`No tool named ${name}`);
      return tool.call(context, input);
    };
    const toolInputs = {
      create_public_link: { path: "users" },
      grant_permission: {
        path: "users",
        subject: { type: "user", email: "carol@example.test" },
        permission: "read",
      },
    };
    for (const [name, input] of Object.entries(toolInputs)) {
      const refused = await call(name, input);
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(refused.message).toContain(
          "Allow sharing the home folders container",
        );
      const tool = mcpTools.find((entry) => entry.name === name);
      expect(tool?.description).toContain("acknowledgeAllHomeFolders");
    }
    await allow(true);
    for (const [name, input] of Object.entries(toolInputs)) {
      const unacknowledged = await call(name, input);
      expect(unacknowledged.ok).toBe(false);
      if (!unacknowledged.ok)
        expect(unacknowledged.message).toContain("4 home folders");
      expect(
        (await call(name, { ...input, acknowledgeAllHomeFolders: true })).ok,
      ).toBe(true);
    }
    expect(sharingCount()).toMatchObject({ grants: 1, links: 1 });
  });

  test("only an administrator in their own browser session can change the setting, and each change is audited", async () => {
    for (const [as, session] of [
      ["alice", "browser"],
      ["owner", "impersonated"],
      ["owner", "none"],
    ] as const)
      await expect(
        drive
          .caller(as, session)
          .access.setHomeContainerSharing({ allowed: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await drive.store.homeContainerSharingAllowed()).toBe(false);
    await allow(true);
    await allow(true);
    await allow(false);
    await flushAudit();
    expect(
      audit
        .filter((event) => event.action === "setting.changed")
        .map((event) => ({
          actor: event.actor,
          target: event.target,
          details: event.details,
        })),
    ).toEqual([
      {
        actor: { type: "user", id: "owner", label: "owner@example.test" },
        target: {
          type: "setting",
          id: "allow_home_container_sharing",
          label: "Allow sharing the home folders container",
        },
        details: { previous: false, allowed: true },
      },
      {
        actor: { type: "user", id: "owner", label: "owner@example.test" },
        target: {
          type: "setting",
          id: "allow_home_container_sharing",
          label: "Allow sharing the home folders container",
        },
        details: { previous: true, allowed: false },
      },
    ]);
    const row = drive.sqlite
      .query<{ updated_by: string; updated_at: number }, []>(
        "SELECT updated_by, updated_at FROM nimbus_server_setting WHERE id = 0",
      )
      .get();
    expect(row?.updated_by).toBe("owner");
    expect(row?.updated_at).toBeGreaterThan(0);
  });

  test("turning it off again keeps existing sharing, lists it for review, and blocks new homes until it is removed", async () => {
    await allow(true);
    await grant("users", true);
    const { token } = await link("", true);
    await uploadLink("users", true);
    await allow(false);
    // Nothing was deleted, and the link still works.
    expect(sharingCount()).toEqual({ grants: 1, links: 1, uploadLinks: 1 });
    expect(await drive.store.getShare(token)).not.toBeNull();
    const review = await drive.caller("owner").access.homeContainerSharing();
    expect(review.allowed).toBe(false);
    expect(review.homes).toBe(4);
    expect(review.records.grants.map((entry) => entry.path)).toEqual(["users"]);
    expect(review.records.links.map((entry) => entry.path)).toEqual([""]);
    expect(review.records.fileRequests.map((entry) => entry.path)).toEqual([
      "users",
    ]);
    await expect(
      drive.caller("alice").access.homeContainerSharing(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // While a grant or link covers the container, a new account gets no home.
    drive.sqlite.run(
      "INSERT INTO user (id, name, email, role) VALUES ('dave', 'dave', 'dave@example.test', 'user')",
    );
    expect(
      (
        await Homes.provision(drive.store, {
          id: "dave",
          email: "dave@example.test",
        })
      ).kind,
    ).toBe("failed");
    for (const entry of [
      ...review.records.grants.map((record) => ({
        kind: "grant" as const,
        id: record.id,
      })),
      ...review.records.links.map((record) => ({
        kind: "link" as const,
        id: record.id,
      })),
      ...review.records.fileRequests.map((record) => ({
        kind: "uploadLink" as const,
        id: record.id,
      })),
    ])
      await drive
        .caller("owner", "browser")
        .access.removeHomeContainerSharing(entry);
    expect(sharingCount()).toEqual(nothingShared);
    expect(
      await Homes.provision(drive.store, {
        id: "dave",
        email: "dave@example.test",
      }),
    ).toEqual({ kind: "created", path: "users/dave" });
    await flushAudit();
    expect(
      audit
        .filter((event) =>
          ["grant.removed", "share.revoked", "file_request.revoked"].includes(
            event.action,
          ),
        )
        .map((event) => event.action)
        .sort(),
    ).toEqual(["file_request.revoked", "grant.removed", "share.revoked"]);
  });

  test("a container shared through the setting does not stop the next start", async () => {
    await allow(true);
    await grant("users", true);
    expect(await Homes.prepare(drive.store)).toEqual({
      kind: "ready",
      path: "users",
      created: false,
    });
  });

  test("an item cannot move or be restored to the container's place, carrying its sharing there", async () => {
    await mkdir(drive.absolute("staging/users"), { recursive: true });
    await grant("docs");
    await grant("staging/users");
    await mkdir(drive.absolute("old"));
    await grant("old");
    const trashed = await drive.caller("owner").files.delete({ path: "old" });
    // The container went missing outside Nimbus; shared folders must not take its place.
    await rename(drive.absolute("users"), drive.absolute("users-gone"));
    for (const newName of ["users", "USERS"])
      await expect(
        drive.caller("owner").files.rename({ path: "docs", newName }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      drive
        .caller("owner")
        .files.move({ sourcePath: "staging/users", destinationPath: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A trashed folder whose place became the container's is not restored there either.
    process.env.NIMBUS_HOMES_PATH = "old";
    expect(await Homes.prepare(drive.store)).toMatchObject({ kind: "ready" });
    await rename(drive.absolute("old"), drive.absolute("old-gone"));
    await expect(
      drive.caller("owner").trash.restore({ id: trashed.trashId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(sharingCount().grants).toBe(2);
  });

  test("anyone who can share a path can ask what sharing it would expose", async () => {
    expect(
      await drive
        .caller("owner")
        .access.homeFoldersExposure({ path: "users/alice" }),
    ).toEqual({ kind: "none" });
    expect(
      await drive.caller("owner").access.homeFoldersExposure({ path: "" }),
    ).toEqual({
      kind: "refused",
      homes: 4,
      container: "users",
      relation: "above",
    });
    await allow(true);
    expect(
      await drive.caller("owner").access.homeFoldersExposure({ path: "users" }),
    ).toEqual({ kind: "warn", homes: 4, container: "users", relation: "is" });
    await expect(
      drive.caller("alice").access.homeFoldersExposure({ path: "users" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("spellings that Unicode case folding or normalization equate with the container are refused too", async () => {
    // U+017F LATIN SMALL LETTER LONG S folds to "s" on casefolding volumes.
    for (const alias of ["u\u017fers", "USERS"]) {
      await mkdir(drive.absolute(alias));
      await expect(link(alias)).rejects.toBeInstanceOf(HomesExposureError);
    }
    process.env.NIMBUS_HOMES_PATH = "caf\u00e9";
    expect(await Homes.prepare(drive.store)).toMatchObject({ kind: "ready" });
    // The same name decomposed, as macOS and some NAS volumes store it.
    const decomposed = "cafe\u0301";
    await mkdir(drive.absolute(decomposed));
    await expect(grant(decomposed)).rejects.toBeInstanceOf(HomesExposureError);
    expect((await Homes.protection(drive.store))(decomposed)).toBe(true);
  });

  test("a new home never takes the place of a folder that held home folders before", async () => {
    // users/alice was itself a container once; its folder is gone, its record is not.
    await drive.store.addHomeContainer("users/alice-old");
    drive.sqlite.run(
      "INSERT INTO user (id, name, email, role) VALUES ('dave', 'dave', 'alice-old@new.test', 'user')",
    );
    expect(
      await Homes.provision(drive.store, {
        id: "dave",
        email: "alice-old@new.test",
      }),
    ).toEqual({ kind: "created", path: "users/alice-old-2" });
  });

  test("turning the setting off waits for a share already being created, so none appears afterwards", async () => {
    await allow(true);
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const read = drive.store.homeContainerSharingAllowed.bind(drive.store);
    drive.store.homeContainerSharingAllowed = async () => {
      const allowed = await read();
      // Hold the first share's check after it has read "allowed".
      if (++reads === 1) await paused;
      return allowed;
    };
    const order: string[] = [];
    const creating = link("users", true).then(() => order.push("link"));
    while (reads === 0) await Bun.sleep(1);
    const disabling = allow(false).then(() => order.push("off"));
    await Bun.sleep(20);
    release();
    await Promise.all([creating, disabling]);
    expect(order).toEqual(["link", "off"]);
    // Created before the setting went off, so it is listed for review; a later one is refused.
    const review = await drive.caller("owner").access.homeContainerSharing();
    expect(review.records.links).toHaveLength(1);
    await expect(link("users", true)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
