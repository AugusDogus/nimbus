import { describe, expect, it } from "bun:test";
import type { TransferReceipt } from "@nimbus/api/transfer-receipt";
import { TransferResult } from "./transfer-result";
import type { FileEntry } from "./types";

const entry = (name: string, folder = "docs"): FileEntry => ({
  name,
  path: `${folder}/${name}`,
  type: "file",
  permission: "write",
  fixed: false,
  mtime: null,
  size: null,
});
const receipt = (from: string, to: string): TransferReceipt => ({
  id: `${from}>${to}`,
  boot: "run",
  operation: "move",
  actor: "user-1",
  from,
  to,
  identity: "file::1:1",
  issuedAt: 1,
  seal: "0".repeat(64),
});

describe("TransferResult", () => {
  it("keeps a receipt for each transferred item and a reason for each failure", async () => {
    const items = ["a.txt", "b.txt", "c.txt"].map((name) => entry(name));
    const result = await TransferResult.run(
      "move",
      "archive",
      items,
      async (item) => {
        if (item.name === "b.txt") throw new Error("It is locked.");
        const to = `archive/${item.name}`;
        return { name: item.name, path: to, receipt: receipt(item.path, to) };
      },
    );
    expect(result.transferred.map((item) => item.receipt.to).sort()).toEqual([
      "archive/a.txt",
      "archive/c.txt",
    ]);
    expect(result.failed).toEqual([
      { source: items[1] ?? entry("missing"), reason: "It is locked." },
    ]);
    expect(TransferResult.describe(result)).toEqual({
      ok: false,
      message: "Moved 2 of 3 items to archive. “b.txt”: It is locked.",
    });
  });

  it("names the destination, and the new name a copy got", async () => {
    const one = await TransferResult.run(
      "copy",
      "",
      [entry("a.txt")],
      async () => ({
        name: "a (1).txt",
        path: "a (1).txt",
        receipt: receipt("docs/a.txt", "a (1).txt"),
      }),
    );
    expect(TransferResult.describe(one)).toEqual({
      ok: true,
      message: "Copied “a.txt” to Files as “a (1).txt”.",
    });
    const many = await TransferResult.run(
      "copy",
      "projects/archive",
      [entry("a.txt"), entry("b.txt")],
      async (item) => ({
        name: item.name === "a.txt" ? "a (1).txt" : item.name,
        path: "x",
        receipt: receipt(item.path, "x"),
      }),
    );
    expect(TransferResult.describe(many)).toEqual({
      ok: true,
      message:
        "Copied 2 items to archive. 1 got a new name because the name was taken.",
    });
  });

  it("says nothing was transferred when every item failed", async () => {
    const result = await TransferResult.run(
      "move",
      "archive",
      [entry("a.txt"), entry("b.txt")],
      async () => {
        throw new Error("You need write permission for this item.");
      },
    );
    expect(TransferResult.describe(result)).toEqual({
      ok: false,
      message:
        "Nothing was moved to archive. “a.txt”: You need write permission for this item. 1 more item also failed.",
    });
  });
});
