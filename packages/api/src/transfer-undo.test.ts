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
import { forgetFileMutationsForTest } from "./file-mutations";
import { appRouter } from "./routers";
import { createTestDriveStore, transferredOf } from "./testing";
import { TransferReceipt } from "./transfer-receipt";

describe("undoing moves and copies", () => {
  let root: string;
  let previousRoot: string | undefined;
  let memory: ReturnType<typeof createTestDriveStore>;
  const caller = (id = "user-1") =>
    appRouter.createCaller({
      headers: new Headers(),
      session: { user: { id } },
      sessionStillValid: async () => true,
      drive: memory.store,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_id, value) => value,
      },
    });
  const exists = (relative: string) =>
    readdir(path.join(root, path.dirname(relative))).then(
      (names) => names.includes(path.basename(relative)),
      () => false,
    );
  const grant = (id: string, grantPath: string, permission: "read" | "write") =>
    memory.grants.set(id, {
      id,
      subject: { type: "user", id: "reader" },
      path: grantPath,
      permission,
    });
  const move = async (
    sourcePath: string,
    destinationPath: string,
    id = "user-1",
  ) =>
    transferredOf(await caller(id).files.move({ sourcePath, destinationPath }));
  const copy = async (
    sourcePath: string,
    destinationPath: string,
    id = "user-1",
  ) =>
    transferredOf(await caller(id).files.copy({ sourcePath, destinationPath }));
  const undo = async (receipts: TransferReceipt[], id = "user-1") =>
    (await caller(id).files.undo({ receipts })).outcomes;

  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-undo-"));
    process.env.NIMBUS_DATA_ROOT = root;
    memory = createTestDriveStore();
    await mkdir(path.join(root, "docs/sub"), { recursive: true });
    await mkdir(path.join(root, "archive"));
    await writeFile(path.join(root, "docs/report.txt"), "report");
    await writeFile(path.join(root, "docs/sub/inner.txt"), "inner");
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("moves an item back with its sharing", async () => {
    await memory.store.createShare({
      id: "link",
      token: "link",
      path: "docs/sub",
      createdBy: "user-1",
      createdAt: 1,
      expiresAt: null,
      passwordHash: null,
      downloadCount: 0,
      maxDownloads: null,
      mode: "download",
    });
    const moved = await move("docs/sub", "archive");
    expect((await memory.store.getShare("link"))?.path).toBe("archive/sub");
    expect(await undo([moved.receipt])).toMatchObject([{ kind: "undone" }]);
    expect(await readFile(path.join(root, "docs/sub/inner.txt"), "utf8")).toBe(
      "inner",
    );
    expect(await exists("archive/sub")).toBe(false);
    expect((await memory.store.getShare("link"))?.path).toBe("docs/sub");
  });

  it("sends a copy to trash and leaves the original", async () => {
    const copied = await copy("docs/report.txt", "archive");
    expect(await undo([copied.receipt])).toMatchObject([{ kind: "undone" }]);
    expect(await exists("archive/report.txt")).toBe(false);
    expect(await exists("docs/report.txt")).toBe(true);
    expect([...memory.trash.values()].map((item) => item.path)).toEqual([
      "archive/report.txt",
    ]);
  });

  it("leaves an item that was edited since", async () => {
    const moved = await move("docs/report.txt", "archive");
    await Bun.sleep(5);
    await writeFile(path.join(root, "archive/report.txt"), "edited later");
    expect(await undo([moved.receipt])).toMatchObject([
      {
        kind: "kept",
        reason: "changed",
        message: "“report.txt” was changed since and stayed in “archive”.",
      },
    ]);
    expect(await exists("archive/report.txt")).toBe(true);
    expect(await exists("docs/report.txt")).toBe(false);
  });

  it("leaves other content that replaced the item, and never trashes a replaced copy", async () => {
    const moved = await move("docs/sub", "archive");
    const copied = await copy("docs/report.txt", "archive");
    await rm(path.join(root, "archive/sub"), { recursive: true });
    await rm(path.join(root, "archive/report.txt"));
    await Bun.sleep(5);
    await mkdir(path.join(root, "archive/sub"));
    await writeFile(path.join(root, "archive/report.txt"), "report");
    expect(await undo([moved.receipt, copied.receipt])).toMatchObject([
      { kind: "kept", reason: "changed" },
      { kind: "kept", reason: "changed" },
    ]);
    expect(await exists("archive/sub")).toBe(true);
    expect(await exists("archive/report.txt")).toBe(true);
    expect(memory.trash.size).toBe(0);
  });

  it("reports an item deleted since", async () => {
    const moved = await move("docs/report.txt", "archive");
    await rm(path.join(root, "archive/report.txt"));
    expect(await undo([moved.receipt])).toMatchObject([
      { kind: "kept", reason: "missing" },
    ]);
  });

  it("does not move back over something now at the original path", async () => {
    const moved = await move("docs/report.txt", "archive");
    await writeFile(path.join(root, "docs/report.txt"), "new report");
    expect(await undo([moved.receipt])).toMatchObject([
      {
        kind: "kept",
        reason: "original-taken",
        message:
          "Something else is now called “report.txt” in “docs”, so “report.txt” stayed in “archive”.",
      },
    ]);
    expect(await readFile(path.join(root, "docs/report.txt"), "utf8")).toBe(
      "new report",
    );
    expect(await exists("archive/report.txt")).toBe(true);
  });

  it("checks permissions again: an account that lost access changes nothing", async () => {
    grant("docs", "docs", "write");
    grant("archive", "archive", "write");
    const moved = await move("docs/report.txt", "archive", "reader");
    memory.grants.delete("docs");
    grant("docs-read", "docs", "read");
    expect(await undo([moved.receipt], "reader")).toMatchObject([
      { kind: "kept", reason: "forbidden" },
    ]);
    expect(await exists("archive/report.txt")).toBe(true);
    const copied = await copy("docs/sub", "archive", "reader");
    memory.grants.delete("archive");
    grant("archive-read", "archive", "read");
    expect(await undo([copied.receipt], "reader")).toMatchObject([
      { kind: "kept", reason: "forbidden" },
    ]);
    expect(await exists("archive/sub")).toBe(true);
    expect(memory.trash.size).toBe(0);
  });

  it("refuses receipts that were forged, are another account's, or expired", async () => {
    grant("docs", "docs", "write");
    grant("archive", "archive", "write");
    const moved = await move("docs/report.txt", "archive", "reader");
    // The owner's file, pointed at by a receipt edited to look like the reader's move.
    await writeFile(path.join(root, "archive/owner.txt"), "owner");
    const forged = { ...moved.receipt, to: "archive/owner.txt" };
    expect(await undo([forged], "reader")).toMatchObject([
      { kind: "kept", reason: "forged" },
    ]);
    expect(await undo([moved.receipt], "user-1")).toMatchObject([
      { kind: "kept", reason: "other-account" },
    ]);
    const old = TransferReceipt.issue(
      {
        operation: "move",
        actor: "reader",
        from: "docs/report.txt",
        to: "archive/report.txt",
        identity: moved.receipt.identity,
      },
      Date.now() - 2 * 60 * 60 * 1000,
    );
    expect(await undo([old], "reader")).toMatchObject([
      { kind: "kept", reason: "expired" },
    ]);
    expect(await exists("archive/report.txt")).toBe(true);
    expect(await exists("archive/owner.txt")).toBe(true);
  });

  it("undoes the rest when some items no longer match, and reports each", async () => {
    await writeFile(path.join(root, "docs/b.txt"), "b");
    const first = await move("docs/report.txt", "archive");
    const second = await move("docs/b.txt", "archive");
    const third = await move("docs/sub", "archive");
    await Bun.sleep(5);
    await writeFile(path.join(root, "archive/b.txt"), "changed");
    const outcomes = await undo([first.receipt, second.receipt, third.receipt]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "undone",
      "kept",
      "undone",
    ]);
    expect(await exists("docs/report.txt")).toBe(true);
    expect(await exists("docs/sub")).toBe(true);
    expect(await exists("archive/b.txt")).toBe(true);
  });

  /** The receipt in a move or copy result, whatever else the result says. */
  const receiptOf = (result: object) => {
    if (!("receipt" in result))
      throw new Error("Expected the item to be transferred, with a receipt.");
    return TransferReceipt.schema.parse(result.receipt);
  };

  it("undoes each receipt once", async () => {
    const first = receiptOf(
      await caller().files.move({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
      }),
    );
    expect(await undo([first])).toMatchObject([{ kind: "undone" }]);
    expect(await undo([first])).toMatchObject([
      { kind: "kept", reason: "used" },
    ]);
    // Moved there again on purpose: the earlier receipt still does nothing.
    await caller().files.move({
      sourcePath: "docs/report.txt",
      destinationPath: "archive",
    });
    expect(await undo([first])).toMatchObject([
      {
        kind: "kept",
        reason: "used",
        message: "This change was already undone, so nothing more was changed.",
      },
    ]);
    expect(await exists("archive/report.txt")).toBe(true);

    const copied = receiptOf(
      await caller().files.copy({
        sourcePath: "docs/sub",
        destinationPath: "archive",
      }),
    );
    expect(await undo([copied])).toMatchObject([{ kind: "undone" }]);
    const [trashed] = [...memory.trash.values()];
    if (!trashed) throw new Error("Expected the undone copy in trash.");
    await caller().trash.restore({ id: trashed.id });
    expect(await undo([copied])).toMatchObject([
      { kind: "kept", reason: "used" },
    ]);
    expect(await exists("archive/sub")).toBe(true);
  });

  it("moves a folder back after entries were added to it, but keeps a copy someone added to", async () => {
    const moved = receiptOf(
      await caller().files.move({
        sourcePath: "docs/sub",
        destinationPath: "archive",
      }),
    );
    const copied = receiptOf(
      await caller().files.copy({
        sourcePath: "archive/sub",
        destinationPath: "",
      }),
    );
    await Bun.sleep(5);
    await writeFile(path.join(root, "archive/sub/added.txt"), "added");
    await writeFile(path.join(root, "sub/added.txt"), "added");
    expect(await undo([moved, copied])).toMatchObject([
      { kind: "undone" },
      { kind: "kept", reason: "changed" },
    ]);
    expect(await exists("docs/sub/added.txt")).toBe(true);
    expect(await exists("sub/added.txt")).toBe(true);
    expect(memory.trash.size).toBe(0);
  });

  it("refuses receipts from before a restart, saying so", async () => {
    const earlier = TransferReceipt.issue(
      {
        operation: "move",
        actor: "user-1",
        from: "docs/report.txt",
        to: "archive/report.txt",
        identity: "v2:file:1:1:1:1:6",
      },
      Date.now(),
      "an-earlier-run",
    );
    expect(await undo([earlier])).toMatchObject([
      {
        kind: "kept",
        reason: "restarted",
        message:
          "“report.txt” stayed in “archive”: Nimbus restarted since, so this change can no longer be undone. Move it back yourself.",
      },
    ]);
  });

  it("never reports a copy as not made when something fails after it is on disk", async () => {
    memory.store.copyDavProperties = async () => {
      throw new Error(`EIO: i/o error, open '${root}/.nimbus/dav'`);
    };
    const outcome = await caller().files.copy({
      sourcePath: "docs/report.txt",
      destinationPath: "archive",
    });
    expect(outcome.kind).toBe("unknown");
    if (outcome.kind !== "unknown") return;
    expect(outcome.message).toBe(
      "Something went wrong after “report.txt” was copied to “archive”, so part of it may not have carried over. Check “archive”.",
    );
    expect(outcome.message).not.toContain(root);
    expect(await exists("archive/report.txt")).toBe(true);
  });

  it("keeps what an Undo already did when a later item fails unexpectedly", async () => {
    await writeFile(path.join(root, "docs/other.txt"), "other");
    const first = await move("docs/report.txt", "archive");
    const second = await move("docs/other.txt", "archive");
    const movePath = memory.store.movePath.bind(memory.store);
    memory.store.movePath = async (from, to, settles) => {
      if (from === "archive/report.txt")
        throw new Error(`SQLITE_IOERR: disk I/O error at ${root}`);
      return movePath(from, to, settles);
    };
    const outcomes = await undo([first.receipt, second.receipt]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "unknown",
      "undone",
    ]);
    const [failed] = outcomes;
    expect(failed?.kind === "unknown" && failed.message).toBe(
      "Something went wrong partway through undoing “report.txt”, so Nimbus cannot say how it ended. Check “docs” and “archive”.",
    );
    expect(await exists("docs/other.txt")).toBe(true);
  });
});
