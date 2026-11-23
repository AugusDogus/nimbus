import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appRouter } from "./routers";
import { forgetFileMutationsForTest } from "./file-mutations";
import { createTestDriveStore, transferredOf } from "./testing";
import {
  ItemIdentity,
  RECEIPT_LIFETIME_MS,
  TransferReceipt,
} from "./transfer-receipt";

const fields = {
  operation: "move",
  actor: "user-1",
  from: "docs/report.txt",
  to: "archive/report.txt",
  identity: "v2:file:9:100:1:1:8",
} as const;

describe("transfer receipts", () => {
  it("verify a receipt sealed for the same account", () => {
    const receipt = TransferReceipt.issue(fields, 1_000);
    expect(TransferReceipt.verify(receipt, "user-1", 2_000)).toEqual({
      ok: true,
    });
  });

  it("refuse a receipt whose fields were changed", () => {
    const receipt = TransferReceipt.issue(fields, 1_000);
    for (const forged of [
      { ...receipt, from: "secret/other.txt" },
      { ...receipt, to: "archive/elsewhere.txt" },
      { ...receipt, operation: "copy" as const },
      { ...receipt, identity: "v2:file:9:100:1:1:9" },
      { ...receipt, id: "another" },
      { ...receipt, issuedAt: 1_500 },
      { ...receipt, seal: "0".repeat(64) },
    ])
      expect(TransferReceipt.verify(forged, "user-1", 2_000)).toEqual({
        ok: false,
        reason: "forged",
      });
  });

  it("refuse another account's receipt, even with that account named in it", () => {
    const receipt = TransferReceipt.issue(fields, 1_000);
    expect(TransferReceipt.verify(receipt, "reader", 2_000)).toEqual({
      ok: false,
      reason: "other-account",
    });
    expect(
      TransferReceipt.verify({ ...receipt, actor: "reader" }, "reader", 2_000),
    ).toEqual({ ok: false, reason: "forged" });
  });

  it("refuse receipts issued before the server restarted", () => {
    const receipt = TransferReceipt.issue(fields, 1_000);
    // Sealed by this server, but in another run of it: inode numbers no longer hold.
    const earlier = TransferReceipt.issue(fields, 1_000, "an-earlier-run");
    expect(TransferReceipt.verify(receipt, "user-1", 2_000)).toEqual({
      ok: true,
    });
    expect(TransferReceipt.verify(earlier, "user-1", 2_000)).toEqual({
      ok: false,
      reason: "restarted",
    });
  });

  it("expire after their lifetime", () => {
    const receipt = TransferReceipt.issue(fields, 1_000);
    expect(
      TransferReceipt.verify(receipt, "user-1", 1_000 + RECEIPT_LIFETIME_MS),
    ).toEqual({ ok: true });
    expect(
      TransferReceipt.verify(receipt, "user-1", 1_001 + RECEIPT_LIFETIME_MS),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("parse only well-formed receipts", () => {
    const receipt = TransferReceipt.issue(fields, 1_000);
    expect(TransferReceipt.schema.safeParse(receipt).success).toBe(true);
    expect(
      TransferReceipt.schema.safeParse({ ...receipt, operation: "delete" })
        .success,
    ).toBe(false);
    expect(
      TransferReceipt.schema.safeParse({ ...receipt, seal: "not hex" }).success,
    ).toBe(false);
  });
});

describe("item identities", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-identity-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const at = (relative: string) => path.join(root, relative);

  /** Readings of one path without a birth time, as Unraid user shares (shfs) report them. */
  const unborn = (
    kind: "file" | "dir",
    times: { ino?: bigint; ctime: bigint; mtime: bigint; size?: bigint },
  ) => ({
    dev: BigInt(9),
    ino: times.ino ?? BigInt(100),
    ctimeNs: times.ctime,
    mtimeNs: times.mtime,
    birthtimeNs: BigInt(0),
    size: times.size ?? BigInt(4),
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
  });
  /** Readings of one path with a birth time, as ext4, btrfs and XFS report them. */
  const born = (
    kind: "file" | "dir",
    birth: bigint,
    times: Parameters<typeof unborn>[1],
  ) => ({ ...unborn(kind, times), birthtimeNs: birth });

  it("recognise an item after a rename, and nothing where it was", async () => {
    await writeFile(at("a.txt"), "data");
    await mkdir(at("folder"));
    await rename(at("a.txt"), at("folder/b.txt"));
    // Read after the transfer, as moves and copies do: a rename changes the change time.
    const identity = await ItemIdentity.identityAt(at("folder/b.txt"));
    expect(await ItemIdentity.matchAt(at("folder/b.txt"), identity)).toBe(
      "same",
    );
    expect(await ItemIdentity.matchAt(at("a.txt"), identity)).toBe("missing");
  });

  it("tell a replacement from the item, even with the same size and modification time", async () => {
    await writeFile(at("report.txt"), "original");
    const identity = await ItemIdentity.identityAt(at("report.txt"));
    const { mtime } = await stat(at("report.txt"));
    await rm(at("report.txt"));
    await writeFile(at("report.txt"), "replaced");
    await utimes(at("report.txt"), mtime, mtime);
    expect(await ItemIdentity.matchAt(at("report.txt"), identity)).toBe(
      "changed",
    );
  });

  it("without birth times, tell a replacement with the same size and modification time", async () => {
    const identity = await ItemIdentity.identityAt("x", async () =>
      unborn("file", { ctime: BigInt(50), mtime: BigInt(40) }),
    );
    // Written elsewhere and renamed into place, with its modification time set to the item's.
    expect(
      await ItemIdentity.matchAt("x", identity, "exact", async () =>
        unborn("file", {
          ino: BigInt(101),
          ctime: BigInt(70),
          mtime: BigInt(40),
        }),
      ),
    ).toBe("changed");
    // Rewritten in place and given the old modification time back: the change time moved.
    expect(
      await ItemIdentity.matchAt("x", identity, "exact", async () =>
        unborn("file", { ctime: BigInt(70), mtime: BigInt(40) }),
      ),
    ).toBe("changed");
    expect(
      await ItemIdentity.matchAt("x", identity, "exact", async () =>
        unborn("file", { ctime: BigInt(50), mtime: BigInt(40) }),
      ),
    ).toBe("same");
  });

  it("count a rewrite or a permission change of a file as a change", async () => {
    await writeFile(at("a.txt"), "data");
    const identity = await ItemIdentity.identityAt(at("a.txt"));
    await Bun.sleep(5);
    await chmod(at("a.txt"), 0o600);
    expect(await ItemIdentity.matchAt(at("a.txt"), identity)).toBe("changed");
  });

  it("let a moved folder go back after entries change inside it, but nothing else", async () => {
    await mkdir(at("x"));
    const identity = await ItemIdentity.identityAt(at("x"));
    await Bun.sleep(5);
    await writeFile(at("x/added.txt"), "new");
    expect(await ItemIdentity.matchAt(at("x"), identity, "entries")).toBe(
      "same",
    );
    // A copy with new work in it is never treated as the copy that was made.
    expect(await ItemIdentity.matchAt(at("x"), identity)).toBe("changed");
    await Bun.sleep(5);
    await chmod(at("x"), 0o750);
    expect(await ItemIdentity.matchAt(at("x"), identity, "entries")).toBe(
      "changed",
    );
  });

  it("with birth times, refuse a folder put in the item's place on its inode number, but not one with entries changed", async () => {
    const identity = await ItemIdentity.identityAt("x", async () =>
      born("dir", BigInt(20), { ctime: BigInt(50), mtime: BigInt(40) }),
    );
    const read =
      (birth: bigint, times: Parameters<typeof unborn>[1]) => async () =>
        born("dir", birth, times);
    // Another inode is another folder, whatever its times.
    expect(
      await ItemIdentity.matchAt(
        "x",
        identity,
        "entries",
        read(BigInt(20), {
          ino: BigInt(101),
          ctime: BigInt(60),
          mtime: BigInt(60),
        }),
      ),
    ).toBe("changed");
    // The same inode with entries changed since: the folder itself.
    expect(
      await ItemIdentity.matchAt(
        "x",
        identity,
        "entries",
        read(BigInt(20), { ctime: BigInt(60), mtime: BigInt(60) }),
      ),
    ).toBe("same");
    // The same inode, given by ext4 to a folder created after the item was deleted.
    expect(
      await ItemIdentity.matchAt(
        "x",
        identity,
        "entries",
        read(BigInt(60), { ctime: BigInt(60), mtime: BigInt(60) }),
      ),
    ).toBe("changed");
    // Times from before the transfer cannot be the folder as it was left.
    expect(
      await ItemIdentity.matchAt(
        "x",
        identity,
        "entries",
        read(BigInt(20), { ctime: BigInt(30), mtime: BigInt(30) }),
      ),
    ).toBe("changed");
  });

  it("without birth times, take a moved folder back only as it was left", async () => {
    const identity = await ItemIdentity.identityAt("x", async () =>
      unborn("dir", { ctime: BigInt(50), mtime: BigInt(40) }),
    );
    const read = (times: Parameters<typeof unborn>[1]) => async () =>
      unborn("dir", times);
    expect(
      await ItemIdentity.matchAt(
        "x",
        identity,
        "entries",
        read({ ctime: BigInt(50), mtime: BigInt(40) }),
      ),
    ).toBe("same");
    // Entries changed since, or a folder created in its place on the same inode number: these
    // read alike, so both are refused.
    expect(
      await ItemIdentity.matchAt(
        "x",
        identity,
        "entries",
        read({ ctime: BigInt(60), mtime: BigInt(60) }),
      ),
    ).toBe("changed");
    expect(
      await ItemIdentity.matchAt(
        "x",
        identity,
        "entries",
        read({ ino: BigInt(101), ctime: BigInt(60), mtime: BigInt(60) }),
      ),
    ).toBe("changed");
  });

  it("refuse a real folder created in the item's place, read as if its inode number were reused", async () => {
    await mkdir(at("x"));
    const original = await lstat(at("x"), { bigint: true });
    const identity = await ItemIdentity.identityAt(at("x"));
    await rm(at("x"), { recursive: true });
    await Bun.sleep(5);
    await mkdir(at("x"));
    // What ext4 does and this machine's filesystem may not: the new folder gets the old inode.
    const reused = async (absolute: string) => {
      const stats = await lstat(absolute, { bigint: true });
      return {
        dev: original.dev,
        ino: original.ino,
        birthtimeNs: stats.birthtimeNs,
        ctimeNs: stats.ctimeNs,
        mtimeNs: stats.mtimeNs,
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
        isFile: () => stats.isFile(),
      };
    };
    expect(
      await ItemIdentity.matchAt(at("x"), identity, "entries", reused),
    ).toBe("changed");
  });

  it("tell a file from a folder", async () => {
    const identity = await ItemIdentity.identityAt("x", async () =>
      unborn("dir", { ctime: BigInt(5), mtime: BigInt(5) }),
    );
    expect(
      await ItemIdentity.matchAt("x", identity, "entries", async () =>
        unborn("file", { ctime: BigInt(5), mtime: BigInt(5) }),
      ),
    ).toBe("changed");
  });
});

describe("files.move and files.copy receipts", () => {
  let root: string;
  let previousRoot: string | undefined;
  beforeEach(async () => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
    root = await mkdtemp(path.join(os.tmpdir(), "nimbus-receipts-"));
    process.env.NIMBUS_DATA_ROOT = root;
    await mkdir(path.join(root, "docs/sub"), { recursive: true });
    await mkdir(path.join(root, "archive"));
    await writeFile(path.join(root, "docs/report.txt"), "report");
  });
  afterEach(async () => {
    forgetFileMutationsForTest(root);
    await rm(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.NIMBUS_DATA_ROOT;
    else process.env.NIMBUS_DATA_ROOT = previousRoot;
  });
  const caller = () =>
    appRouter.createCaller({
      headers: new Headers(),
      drive: createTestDriveStore().store,
      session: { user: { id: "user-1" } },
      sessionStillValid: async () => true,
      preferences: {
        getUserPreferences: async () => null,
        setUserPreferences: async (_userId, prefs) => prefs,
      },
    });

  it("describe each moved item and where it went", async () => {
    const moved = transferredOf(
      await caller().files.move({
        sourcePath: "docs/sub",
        destinationPath: "archive",
      }),
    );
    expect(moved.receipt).toMatchObject({
      operation: "move",
      actor: "user-1",
      from: "docs/sub",
      to: "archive/sub",
    });
    expect(TransferReceipt.verify(moved.receipt, "user-1")).toEqual({
      ok: true,
    });
    expect(
      await ItemIdentity.matchAt(
        path.join(root, "archive/sub"),
        moved.receipt.identity,
      ),
    ).toBe("same");
  });

  it("describe each copy by the name it got", async () => {
    await writeFile(path.join(root, "archive/report.txt"), "taken");
    const copied = transferredOf(
      await caller().files.copy({
        sourcePath: "docs/report.txt",
        destinationPath: "archive",
      }),
    );
    expect(copied.receipt).toMatchObject({
      operation: "copy",
      from: "docs/report.txt",
      to: "archive/report (1).txt",
    });
    expect(
      await ItemIdentity.matchAt(
        path.join(root, "archive/report (1).txt"),
        copied.receipt.identity,
      ),
    ).toBe("same");
  });
});
