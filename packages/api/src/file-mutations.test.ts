import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAccess } from "./access";
import {
  lockFile,
  locksCovering,
  mutateFiles,
  refreshLock,
  requireLockable,
  unlockFile,
  withMutationPrecondition,
  forgetFileMutationsForTest,
} from "./file-mutations";
import { moveItem } from "./file-operations";
import { appRouter } from "./routers";
import { createTestDriveStore } from "./testing";

describe("filesystem mutation coordination", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const caller = () =>
    appRouter.createCaller({
      headers: new Headers(),
      session: { user: { id: "user-1" } },
      sessionStillValid: async () => true,
      drive: memory.store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    });

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-mutations-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs/first.txt"), "first");
    await writeFile(path.join(root, "docs/second.txt"), "second");
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("preserves both files when concurrent renames choose the same name", async () => {
    const results = await Promise.allSettled([
      caller().files.rename({ path: "docs/first.txt", newName: "result.txt" }),
      caller().files.rename({ path: "docs/second.txt", newName: "result.txt" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const contents = await Promise.all(
      (await readdir(path.join(root, "docs"))).map((name) =>
        readFile(path.join(root, "docs", name), "utf8"),
      ),
    );
    expect(contents.sort()).toEqual(["first", "second"]);
  });

  it("prevents browser writes beneath WebDAV locks, including writes by the lock owner", async () => {
    const lock = lockFile("docs", { userId: "user-1" });
    await expect(
      caller().files.delete({ path: "docs/first.txt" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      caller().files.createFolder({ path: "docs", name: "locked" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    unlockFile("docs", "user-1", `<${lock.token}>`);
    await caller().files.createFolder({ path: "docs", name: "unlocked" });
    expect(await readdir(path.join(root, "docs"))).toContain("unlocked");
  });

  it("requires the lock owner and a positive token condition", async () => {
    const lock = lockFile("docs/first.txt", { userId: "user-1" });
    await expect(
      mutateFiles(
        ["docs/first.txt"],
        { userId: "reader", lockTokens: [lock.token] },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await mutateFiles(
      ["docs/first.txt"],
      { userId: "user-1", lockTokens: [lock.token] },
      async () => {},
    );
    expect(locksCovering("docs/first.txt")[0]?.token).toBe(lock.token);
  });

  it("re-checks a request's precondition once the mutation holds its paths", async () => {
    const owner = { userId: "user-1" };
    let version = 1;
    let releaseFirst = () => {};
    const release = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = mutateFiles(["docs/first.txt"], owner, async () => {
      await release;
      version = 2;
    });
    // The precondition held when the request arrived, but a change was already in progress.
    const loaded = version;
    const second = withMutationPrecondition(
      async () => {
        if (version !== loaded) throw new Error("precondition failed");
      },
      () => mutateFiles(["docs/first.txt"], owner, async () => "written"),
    );
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow("precondition failed");
    expect(
      await withMutationPrecondition(
        async () => {},
        () => mutateFiles(["docs/first.txt"], owner, async () => "written"),
      ),
    ).toBe("written");
  });

  it("caps active locks per user, so one user cannot use up everyone's locks", () => {
    const bob = { userId: "bob" };
    for (let index = 0; index < 1000; index++)
      lockFile(`bob/file-${index}.txt`, bob);
    const refused = { code: "TOO_MANY_REQUESTS" };
    expect(() => requireLockable("bob/one-more.txt", bob)).toThrow(
      expect.objectContaining(refused),
    );
    expect(() => lockFile("bob/one-more.txt", bob)).toThrow(
      expect.objectContaining(refused),
    );
    // Other users still lock as usual.
    expect(lockFile("docs/first.txt", { userId: "alice" }).userId).toBe(
      "alice",
    );
  });

  it("scopes depth-0 collection locks to membership and refuses overlapping locks", async () => {
    const owner = { userId: "user-1" };
    const lock = lockFile("docs", owner, {
      scope: "exclusive",
      depth: "0",
      owner: "",
      timeoutSeconds: 60,
    });
    await mutateFiles(["docs/sub/deeper.txt"], owner, async () => {});
    await expect(
      mutateFiles(["docs/new.txt"], owner, async () => {}),
    ).rejects.toMatchObject({ name: "FileLockedError" });
    await expect(
      mutateFiles([""], owner, async () => {}),
    ).rejects.toMatchObject({ name: "FileLockedError" });
    expect(lockFile("docs/first.txt", owner).path).toBe("docs/first.txt");
    expect(() => lockFile("", owner)).toThrow();
    expect(() =>
      lockFile("docs", owner, {
        scope: "exclusive",
        depth: "0",
        owner: "",
        timeoutSeconds: 60,
      }),
    ).toThrow();
    expect(locksCovering("docs/second.txt")).toEqual([]);
    expect(
      refreshLock("docs", { userId: "reader", lockTokens: [lock.token] }, 120),
    ).toBeNull();
    expect(
      refreshLock("docs", { ...owner, lockTokens: [lock.token] }, 120)
        ?.timeoutSeconds,
    ).toBe(120);
    expect(() =>
      unlockFile("docs/second.txt", "user-1", `<${lock.token}>`),
    ).toThrow();
    unlockFile("docs", "user-1", `<${lock.token}>`);
  });

  it("lets shared locks coexist and accepts any one of their tokens", async () => {
    const shared = {
      scope: "shared" as const,
      depth: "infinity" as const,
      owner: "",
      timeoutSeconds: 60,
    };
    const first = lockFile("docs/first.txt", { userId: "user-1" }, shared);
    const second = lockFile("docs/first.txt", { userId: "reader" }, shared);
    expect(() => lockFile("docs/first.txt", { userId: "user-1" })).toThrow();
    await expect(
      mutateFiles(["docs/first.txt"], { userId: "user-1" }, async () => {}),
    ).rejects.toMatchObject({ name: "FileLockedError" });
    await mutateFiles(
      ["docs/first.txt"],
      { userId: "reader", lockTokens: [second.token] },
      async () => {},
    );
    await expect(
      mutateFiles(
        ["docs/first.txt"],
        { userId: "reader", lockTokens: [first.token] },
        async () => {},
      ),
    ).rejects.toMatchObject({ name: "FileLockedError" });
    expect(locksCovering("docs/first.txt")).toHaveLength(2);
  });

  it("removes locks when a move removes their original resource", async () => {
    const lock = lockFile("docs/first.txt", { userId: "user-1" });
    const access = await getAccess(memory.store, "user-1");
    await moveItem(memory.store, access, "docs/first.txt", "docs/moved.txt", {
      lockTokens: [lock.token],
    });
    expect(locksCovering("docs/first.txt")).toEqual([]);
    expect(await readFile(path.join(root, "docs/moved.txt"), "utf8")).toBe(
      "first",
    );
  });

  it("rechecks revoked permissions before a mutation commits", async () => {
    memory.grants.set("write", {
      id: "write",
      path: "docs",
      subject: { type: "user", id: "reader" },
      permission: "write",
    });
    const previousAccess = await getAccess(memory.store, "reader");
    memory.grants.delete("write");
    await expect(
      moveItem(
        memory.store,
        previousAccess,
        "docs/first.txt",
        "docs/moved.txt",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await readFile(path.join(root, "docs/first.txt"), "utf8")).toBe(
      "first",
    );
  });
});
