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
  unconfirmed: [],
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

const paths = (items: readonly { source: FileEntry }[] = []) =>
  items.map((item) => item.source.path);
const clash = (source: FileEntry) => ({
  source,
  name: source.name,
  suggestion: `${source.name} (1)`,
});

describe("a picker session", () => {
  const a = entry("docs/a.txt");
  const b = entry("docs/b.txt");
  const c = entry("docs/c.txt");

  it("tries only what did not arrive again, and keeps what did", () => {
    let session = TransferSession.start("move", [a, b]);
    session = TransferSession.record(
      session,
      result("archive", {
        transferred: [moved(b, "archive")],
        clashes: [clash(a)],
      }),
    );
    expect(TransferSession.pending(session)).toEqual([a]);
    session = TransferSession.record(
      session,
      result("elsewhere", { transferred: [moved(a, "elsewhere")] }),
    );
    expect(TransferSession.pending(session)).toEqual([]);
    const reports = TransferSession.results(session);
    expect(reports.map((report) => report.destination)).toEqual([
      "archive",
      "elsewhere",
    ]);
    expect(paths(reports[0]?.transferred)).toEqual(["docs/b.txt"]);
    expect(reports[0]?.clashes).toEqual([]);
    expect(paths(reports[1]?.transferred)).toEqual(["docs/a.txt"]);
  });

  it("never lets a later outcome for an item erase its receipt", () => {
    let session = TransferSession.start("move", [a, b]);
    session = TransferSession.record(
      session,
      result("archive", {
        transferred: [moved(b, "archive")],
        clashes: [clash(a)],
      }),
    );
    // Even an answer about an item that already arrived leaves its receipt in place.
    session = TransferSession.record(
      session,
      result("elsewhere", {
        transferred: [moved(a, "elsewhere")],
        failed: [{ source: b, reason: "This file no longer exists." }],
      }),
    );
    expect(
      TransferSession.transferred(session).map((item) => item.receipt.id),
    ).toEqual(["docs/b.txt>archive/b.txt", "docs/a.txt>elsewhere/a.txt"]);
    expect(paths(TransferSession.results(session)[0]?.transferred)).toEqual([
      "docs/b.txt",
    ]);
  });

  it("reports a success, then a clash and a success elsewhere, where each happened", () => {
    let session = TransferSession.start("move", [a, b]);
    session = TransferSession.record(
      session,
      result("one", {
        transferred: [moved(a, "one")],
        failed: [{ source: b, reason: "Locked." }],
      }),
    );
    session = TransferSession.record(
      session,
      result("two", { clashes: [clash(b)] }),
    );
    expect(TransferSession.pending(session)).toEqual([b]);
    session = TransferSession.record(
      session,
      result("three", { transferred: [moved(b, "three")] }),
    );
    const reports = TransferSession.results(session);
    // Nothing is left at "two": the clash there was resolved by moving elsewhere.
    expect(reports.map((report) => report.destination)).toEqual([
      "one",
      "three",
    ]);
    expect(reports[0]?.failed).toEqual([]);
    expect(paths(reports[0]?.transferred)).toEqual(["docs/a.txt"]);
    expect(paths(reports[1]?.transferred)).toEqual(["docs/b.txt"]);
  });

  it("forgets what was undone from the picker, and moves only the rest after", () => {
    let session = TransferSession.start("move", [a, b]);
    const first = moved(a, "archive");
    session = TransferSession.record(
      session,
      result("archive", {
        transferred: [first],
        failed: [{ source: b, reason: "Locked." }],
      }),
    );
    session = TransferSession.undone(session, [first]);
    expect(TransferSession.pending(session)).toEqual([b]);
    session = TransferSession.record(
      session,
      result("elsewhere", { transferred: [moved(b, "elsewhere")] }),
    );
    const reports = TransferSession.results(session);
    expect(reports.map((report) => report.destination)).toEqual(["elsewhere"]);
    expect(paths(reports[0]?.transferred)).toEqual(["docs/b.txt"]);
  });

  it("keeps three destinations apart", () => {
    let session = TransferSession.start("move", [a, b, c]);
    session = TransferSession.record(
      session,
      result("one", {
        transferred: [moved(a, "one")],
        clashes: [clash(b), clash(c)],
      }),
    );
    session = TransferSession.record(
      session,
      result("two", { transferred: [moved(b, "two")], clashes: [clash(c)] }),
    );
    session = TransferSession.record(
      session,
      result("three", { transferred: [moved(c, "three")] }),
    );
    const reports = TransferSession.results(session);
    expect(
      reports.map((report) => [report.destination, paths(report.transferred)]),
    ).toEqual([
      ["one", ["docs/a.txt"]],
      ["two", ["docs/b.txt"]],
      ["three", ["docs/c.txt"]],
    ]);
    expect(reports.flatMap((report) => report.clashes)).toEqual([]);
  });

  it("reports failures and clashes even when nothing moved", () => {
    const session = TransferSession.record(
      TransferSession.start("move", [a, b]),
      result("top", {
        clashes: [clash(a)],
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
      TransferSession.start("move", [a, b]),
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

  it("settles skipped clashes and items already there, which are not tried again", () => {
    const there = entry("top/b.txt");
    let session = TransferSession.record(
      TransferSession.start("move", [a, there, c]),
      result("top", {
        clashes: [clash(a)],
        failed: [{ source: c, reason: "Locked." }],
        alreadyThere: [there],
      }),
    );
    session = TransferSession.skip(session, [clash(a)]);
    expect(TransferSession.pending(session)).toEqual([c]);
    const [report] = TransferSession.results(session);
    expect(paths(report?.skipped)).toEqual(["docs/a.txt"]);
    expect(report?.alreadyThere).toEqual([there]);
  });
});

describe("a session with unconfirmed items", () => {
  it("never tries again an item that may have moved, and reports it where it was sent", () => {
    const a = entry("docs/a.txt");
    const b = entry("docs/b.txt");
    let session = TransferSession.start("move", [a, b]);
    session = TransferSession.record(
      session,
      result("archive", {
        unconfirmed: [a],
        failed: [{ source: b, reason: "Locked." }],
      }),
    );
    expect(TransferSession.pending(session)).toEqual([b]);
    const [report] = TransferSession.results(session);
    expect(report?.unconfirmed).toEqual([a]);
  });
});

describe("a held session", () => {
  const a = entry("docs/a.txt");

  it("reports a transfer still running when the picker closed once it finishes", async () => {
    const session = TransferSession.held(TransferSession.start("move", [a]));
    let answer: (result: TransferResult) => void = () => {};
    const running = session.run(
      () =>
        new Promise<TransferResult>((resolve) => {
          answer = resolve;
        }),
    );
    const reports: TransferSession[] = [];
    session.close((done) => reports.push(done));
    expect(reports).toEqual([]);
    answer(result("archive", { transferred: [moved(a, "archive")] }));
    await running;
    expect(reports).toHaveLength(1);
    expect(
      TransferSession.results(
        reports[0] ?? TransferSession.start("move", []),
      )[0]?.destination,
    ).toBe("archive");
    // Reported once, however often it is closed.
    session.close((done) => reports.push(done));
    expect(reports).toHaveLength(1);
  });

  it("reports at once when nothing is running", () => {
    const session = TransferSession.held(TransferSession.start("move", [a]));
    const reports: TransferSession[] = [];
    session.close((done) => reports.push(done));
    expect(reports).toHaveLength(1);
  });
});
