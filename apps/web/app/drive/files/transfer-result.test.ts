import { describe, expect, it } from "bun:test";
import type { TransferReceipt } from "@nimbus/api/transfer-receipt";
import { TRPCClientError } from "@trpc/client";
import { TransferReport } from "./transfer-report";
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
        return {
          kind: "transferred",
          name: item.name,
          path: to,
          receipt: receipt(item.path, to),
        };
      },
    );
    expect(result.transferred.map((item) => item.receipt.to).sort()).toEqual([
      "archive/a.txt",
      "archive/c.txt",
    ]);
    expect(result.failed).toEqual([
      { source: items[1] ?? entry("missing"), reason: "It is locked." },
    ]);
    expect(TransferReport.describe(result)).toEqual({
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
        kind: "transferred",
        name: "a (1).txt",
        path: "a (1).txt",
        receipt: receipt("docs/a.txt", "a (1).txt"),
      }),
    );
    expect(TransferReport.describe(one)).toEqual({
      ok: true,
      message: "Copied “a.txt” to Files as “a (1).txt”.",
    });
    const many = await TransferResult.run(
      "copy",
      "projects/archive",
      [entry("a.txt"), entry("b.txt")],
      async (item) => ({
        kind: "transferred",
        name: item.name === "a.txt" ? "a (1).txt" : item.name,
        path: "x",
        receipt: receipt(item.path, "x"),
      }),
    );
    expect(TransferReport.describe(many)).toEqual({
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
    expect(TransferReport.describe(result)).toEqual({
      ok: false,
      message:
        "Nothing was moved to archive. “a.txt”: You need write permission for this item. 1 more item also failed.",
    });
  });

  it("keeps items whose names are taken apart, to ask about them", async () => {
    const items = [entry("a.txt"), entry("b.txt"), entry("c.txt")];
    const first = await TransferResult.run(
      "move",
      "archive",
      items,
      async (item) =>
        item.name === "a.txt"
          ? {
              kind: "transferred",
              name: item.name,
              path: `archive/${item.name}`,
              receipt: receipt(item.path, `archive/${item.name}`),
            }
          : { kind: "clash", name: item.name, suggestion: "unused" },
    );
    expect(first.clashes.map((clash) => clash.name)).toEqual([
      "b.txt",
      "c.txt",
    ]);
    expect(TransferReport.describe(first)).toEqual({
      ok: false,
      message:
        "Moved 1 of 3 items to archive. 2 items have names already used there.",
    });
    const retry = await TransferResult.run(
      "move",
      "archive",
      first.clashes.map((clash) => clash.source),
      async (item) => ({
        kind: "transferred",
        name: item.name.replace(".txt", " (1).txt"),
        path: "x",
        receipt: receipt(item.path, "x"),
      }),
    );
    const merged = TransferReport.merge(first, retry);
    expect(merged.clashes).toEqual([]);
    expect(merged.transferred).toHaveLength(3);
    expect(
      TransferReport.describe(TransferReport.skip({ ...first, failed: [] })),
    ).toEqual({
      ok: true,
      message:
        "Moved 1 item to archive. Skipped 2 items whose names were taken.",
    });
    expect(TransferReport.describe(merged)).toEqual({
      ok: true,
      message:
        "Moved 3 items to archive. 2 got new names because the name was taken.",
    });
  });

  it("names the items a move left where they already were", async () => {
    const result = await TransferResult.run(
      "move",
      "archive",
      [entry("incoming.txt")],
      async (item) => ({
        kind: "transferred",
        name: item.name,
        path: `archive/${item.name}`,
        receipt: receipt(item.path, `archive/${item.name}`),
      }),
    );
    const mixed = {
      ...result,
      alreadyThere: [entry("already.txt", "archive")],
    };
    expect(TransferReport.describe(mixed)).toEqual({
      ok: true,
      message:
        "Moved “incoming.txt” to archive. “already.txt” was already there.",
    });
    expect(
      TransferReport.describe({
        ...mixed,
        transferred: [],
        alreadyThere: [entry("a.txt", "archive"), entry("b.txt", "archive")],
      }),
    ).toEqual({
      ok: true,
      message: "Nothing was moved to archive. 2 items were already there.",
    });
  });
});

describe("a report of several destinations", () => {
  const arrived = (name: string, destination: string) => ({
    source: entry(name),
    name,
    path: `${destination}/${name}`,
    receipt: receipt(`docs/${name}`, `${destination}/${name}`),
  });
  const result = (
    destination: string,
    parts: Partial<Omit<TransferResult, "operation" | "destination">>,
  ): TransferResult => ({
    operation: "move",
    destination,
    transferred: [],
    clashes: [],
    skipped: [],
    failed: [],
    alreadyThere: [],
    unconfirmed: [],
    ...parts,
  });

  it("counts what arrived and in how many folders", () => {
    expect(
      TransferReport.describeAll([
        result("one", { transferred: [arrived("a.txt", "one")] }),
        result("two", {
          transferred: [arrived("b.txt", "two"), arrived("c.txt", "two")],
        }),
      ]),
    ).toEqual({ ok: true, message: "Moved 3 items to 2 folders." });
  });

  it("says what did not arrive", () => {
    expect(
      TransferReport.describeAll([
        result("one", {
          transferred: [arrived("a.txt", "one")],
          failed: [{ source: entry("b.txt"), reason: "It is locked." }],
        }),
        result("two", {
          transferred: [arrived("c.txt", "two")],
          clashes: [
            { source: entry("d.txt"), name: "d.txt", suggestion: "d (1).txt" },
          ],
        }),
      ]),
    ).toEqual({
      ok: false,
      message:
        "Moved 2 of 4 items to 2 folders. 1 item could not be moved; see Details for why. 1 item had a name already taken.",
    });
  });

  it("reports one destination as before", () => {
    expect(
      TransferReport.describeAll([
        result("one", { transferred: [arrived("a.txt", "one")] }),
      ]),
    ).toEqual({ ok: true, message: "Moved “a.txt” to one." });
  });
});

describe("a transfer whose answers are lost", () => {
  const lost = () => new TRPCClientError("Failed to fetch");
  const refused = (message: string) =>
    new TRPCClientError(message, {
      result: {
        error: { message, code: -32600, data: { code: "BAD_REQUEST" } },
      },
    });

  it("never claims an outcome for an item whose answer was lost", async () => {
    const items = [entry("a.txt"), entry("b.txt"), entry("c.txt")];
    const result = await TransferResult.run(
      "move",
      "archive",
      items,
      async (item) => {
        if (item.name === "a.txt")
          return {
            kind: "transferred",
            name: item.name,
            path: `archive/${item.name}`,
            receipt: receipt(item.path, `archive/${item.name}`),
          };
        if (item.name === "b.txt") throw refused("It is locked.");
        throw lost();
      },
    );
    expect(result.failed).toEqual([
      { source: items[1] ?? entry("missing"), reason: "It is locked." },
    ]);
    expect(result.unconfirmed.map((item) => item.name)).toEqual(["c.txt"]);
    // Never "Nothing was moved", nor that c.txt failed.
    expect(TransferReport.describe(result)).toEqual({
      ok: false,
      message:
        "Moved 1 of 3 items to archive. Nimbus could not confirm whether “c.txt” moved. Check archive. “b.txt”: It is locked.",
    });
  });

  it("says only that it cannot confirm a copy whose answer was lost", async () => {
    let sent = 0;
    const result = await TransferResult.run(
      "copy",
      "archive",
      [entry("a.txt")],
      async () => {
        sent++;
        throw lost();
      },
    );
    // Sent once: a request that may have been carried out is never sent again.
    expect(sent).toBe(1);
    expect(result.failed).toEqual([]);
    expect(TransferReport.describe(result).message).toBe(
      "Nimbus could not confirm whether “a.txt” was copied. Check archive.",
    );
  });
});
