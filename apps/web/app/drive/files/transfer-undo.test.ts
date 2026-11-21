import { describe, expect, it } from "bun:test";
import type { TransferReceipt } from "@nimbus/api/transfer-receipt";
import type { TransferResult } from "./transfer-result";
import { TransferUndo } from "./transfer-undo";

const transferred = (
  operation: "move" | "copy",
  from: string,
  to: string,
): TransferResult["transferred"][number] => {
  const name = to.split("/").at(-1) ?? to;
  const receipt: TransferReceipt = {
    id: `${from}>${to}`,
    boot: "run",
    operation,
    actor: "user-1",
    from,
    to,
    identity: "file::1:1",
    issuedAt: 1,
    seal: "0".repeat(64),
  };
  return {
    source: {
      name: from.split("/").at(-1) ?? from,
      path: from,
      type: "file",
      permission: "write",
      fixed: false,
      mtime: null,
      size: null,
    },
    name,
    path: to,
    receipt,
  };
};

const moved: TransferResult = {
  operation: "move",
  destination: "archive",
  transferred: [
    transferred("move", "docs/a.txt", "archive/a.txt"),
    transferred("move", "docs/b.txt", "archive/b.txt"),
    transferred("move", "docs/c.txt", "archive/c.txt"),
  ],
  clashes: [],
  skipped: [],
  alreadyThere: [],
  failed: [],
};

describe("TransferUndo", () => {
  it("sends receipts in batches the server accepts and keeps their order", async () => {
    const many: TransferResult = {
      ...moved,
      transferred: Array.from({ length: 1_201 }, (_, index) =>
        transferred("move", `docs/${index}.txt`, `archive/${index}.txt`),
      ),
    };
    const sizes: number[] = [];
    const items = await TransferUndo.run(many, async (receipts) => {
      sizes.push(receipts.length);
      return {
        outcomes: receipts.map((receipt) => ({ kind: "undone", receipt })),
      };
    });
    expect(sizes).toEqual([500, 500, 201]);
    expect(items[1_200]).toEqual({ kind: "undone", name: "1200.txt" });
  });

  it("reports items a failed request could not undo", async () => {
    const items = await TransferUndo.run(moved, async () => {
      throw new Error("The server is offline.");
    });
    expect(items[0]).toEqual({
      kind: "kept",
      name: "a.txt",
      message:
        "Nothing was undone for “a.txt”, because the request failed: The server is offline.",
    });
  });

  it("says where moved items went back to", () => {
    expect(
      TransferUndo.describe(moved, [
        { kind: "undone", name: "a.txt" },
        { kind: "undone", name: "b.txt" },
        { kind: "undone", name: "c.txt" },
      ]),
    ).toEqual({ ok: true, message: "Moved 3 items back to docs." });
  });

  it("names the item that stayed, and why", () => {
    expect(
      TransferUndo.describe(moved, [
        { kind: "undone", name: "a.txt" },
        {
          kind: "kept",
          name: "b.txt",
          message: "“b.txt” was changed since and stayed in “archive”.",
        },
        { kind: "undone", name: "c.txt" },
      ]),
    ).toEqual({
      ok: false,
      message:
        "Moved 2 of 3 items back. “b.txt” was changed since and stayed in “archive”.",
    });
  });

  it("describes undone copies as sent to trash", () => {
    const copied: TransferResult = {
      operation: "copy",
      destination: "archive",
      transferred: [transferred("copy", "docs/a.txt", "archive/a (1).txt")],
      clashes: [],
      skipped: [],
      alreadyThere: [],
      failed: [],
    };
    expect(
      TransferUndo.describe(copied, [{ kind: "undone", name: "a.txt" }]),
    ).toEqual({ ok: true, message: "Moved the copy “a (1).txt” to trash." });
  });
});
