import { describe, expect, it } from "bun:test";
import type { TransferReceipt } from "@nimbus/api/transfer-receipt";
import type { TransferResult } from "../transfer-result";
import type { FileEntry } from "../types";
import { TransferSession } from "./transfer-session";

const entry = (path: string): FileEntry => ({
  name: path.split("/").at(-1) ?? path,
  path,
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
  identity: "v2:file:1:1:1:1:1",
  issuedAt: 1,
  seal: "0".repeat(64),
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
  ...parts,
});
const moved = (source: FileEntry, destination: string) => {
  const to = `${destination}/${source.name}`;
  return {
    source,
    name: source.name,
    path: to,
    receipt: receipt(source.path, to),
  };
};

describe("a picker session", () => {
  const a = entry("docs/a.txt");
  const b = entry("docs/b.txt");

  it("keeps an earlier destination's moves when the rest go elsewhere", () => {
    let session = TransferSession.start("move");
    session = TransferSession.record(
      session,
      result("top", {
        transferred: [moved(b, "top")],
        clashes: [{ source: a, name: "a.txt", suggestion: "a (1).txt" }],
      }),
    );
    session = TransferSession.record(
      session,
      result("elsewhere", { transferred: [moved(a, "elsewhere")] }),
    );
    const reports = TransferSession.results(session);
    expect(reports.map((report) => report.destination)).toEqual([
      "top",
      "elsewhere",
    ]);
    expect(reports[0]?.transferred.map((item) => item.source.path)).toEqual([
      "docs/b.txt",
    ]);
    expect(reports[0]?.clashes).toEqual([]);
    expect(reports[1]?.transferred.map((item) => item.source.path)).toEqual([
      "docs/a.txt",
    ]);
  });

  it("reports failures and clashes even when nothing moved", () => {
    const session = TransferSession.record(
      TransferSession.start("move"),
      result("top", {
        clashes: [{ source: a, name: "a.txt", suggestion: "a (1).txt" }],
        failed: [{ source: b, reason: "This file no longer exists." }],
      }),
    );
    const [report] = TransferSession.results(session);
    expect(report?.clashes).toHaveLength(1);
    expect(report?.failed).toEqual([
      { source: b, reason: "This file no longer exists." },
    ]);
  });

  it("counts a retry that succeeded instead of the failure before it", () => {
    let session = TransferSession.record(
      TransferSession.start("move"),
      result("top", {
        transferred: [moved(a, "top")],
        failed: [{ source: b, reason: "Locked." }],
      }),
    );
    session = TransferSession.record(
      session,
      result("top", { transferred: [moved(b, "top")] }),
    );
    const [report] = TransferSession.results(session);
    expect(report?.failed).toEqual([]);
    expect(report?.transferred).toHaveLength(2);
  });

  it("keeps items already in the destination, and drops moves undone from the picker", () => {
    const first = result("top", {
      transferred: [moved(a, "top")],
      alreadyThere: [entry("top/b.txt")],
    });
    let session = TransferSession.record(TransferSession.start("move"), first);
    session = TransferSession.undone(session, first);
    const [report] = TransferSession.results(session);
    expect(report?.transferred).toEqual([]);
    expect(report?.alreadyThere.map((item) => item.path)).toEqual([
      "top/b.txt",
    ]);
  });
});
