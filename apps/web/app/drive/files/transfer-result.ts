import type { TransferReceipt } from "@nimbus/api/transfer-receipt";
import { folderLabel } from "./drive-root";
import type { FileEntry } from "./types";

export type TransferOperation = "move" | "copy";

/** One item that reached the destination, under the name it got there. */
export type Transferred = {
  source: FileEntry;
  name: string;
  path: string;
  receipt: TransferReceipt;
};

export type TransferFailure = { source: FileEntry; reason: string };

/** An item left where it was because its name is taken in the destination. */
export type TransferClash = { source: FileEntry; name: string };

/** What the server answers for one item: transferred, or its name was taken. */
export type TransferOutcome =
  | {
      kind: "transferred";
      name: string;
      path: string;
      receipt: TransferReceipt;
    }
  | { kind: "clash"; name: string };

/** What a move or copy of several items did to each one. */
export type TransferResult = {
  operation: TransferOperation;
  destination: string;
  transferred: Transferred[];
  clashes: TransferClash[];
  failed: TransferFailure[];
};

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : "The server did not say why.";

/**
 * Transfer every item, a bounded number at a time. The server serializes filesystem commits, so
 * a small window keeps requests batched without queueing thousands of promises.
 */
async function run(
  operation: TransferOperation,
  destination: string,
  items: readonly FileEntry[],
  transfer: (item: FileEntry) => Promise<TransferOutcome>,
  concurrency = 16,
): Promise<TransferResult> {
  const result: TransferResult = {
    operation,
    destination,
    transferred: [],
    clashes: [],
    failed: [],
  };
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      const source = items[index];
      if (!source) continue;
      try {
        const outcome = await transfer(source);
        if (outcome.kind === "clash")
          result.clashes.push({ source, name: outcome.name });
        else
          result.transferred.push({
            source,
            name: outcome.name,
            path: outcome.path,
            receipt: outcome.receipt,
          });
      } catch (error) {
        result.failed.push({ source, reason: reasonOf(error) });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return result;
}

/** `later`, a retry of some of `earlier`'s items, applied to it: each item counted once. */
function merge(earlier: TransferResult, later: TransferResult): TransferResult {
  const retried = new Set(
    [...later.transferred, ...later.clashes, ...later.failed].map(
      (item) => item.source.path,
    ),
  );
  const keep = <T extends { source: FileEntry }>(items: readonly T[]) =>
    items.filter((item) => !retried.has(item.source.path));
  return {
    ...earlier,
    transferred: [...earlier.transferred, ...later.transferred],
    clashes: [...keep(earlier.clashes), ...later.clashes],
    failed: [...keep(earlier.failed), ...later.failed],
  };
}

/** The items to try again: those whose name was taken and those that failed. */
const unfinished = (result: TransferResult) => [
  ...result.clashes.map((item) => item.source),
  ...result.failed.map((item) => item.source),
];

const count = (n: number) =>
  n === 1 ? "1 item" : `${n.toLocaleString()} items`;
const verbs = {
  move: { done: "Moved", none: "moved" },
  copy: { done: "Copied", none: "copied" },
} as const;

/**
 * A summary for a toast: "Moved 3 items to Archive.", "Copied “a.txt” to Archive as
 * “a (1).txt”.", or with failures "Moved 2 of 3 items to Archive. “b.txt”: reason". The
 * server's reason says what happened to the item and what to do, so nothing more is claimed.
 */
function describe(result: TransferResult) {
  const verb = verbs[result.operation];
  const place = folderLabel(result.destination);
  const total =
    result.transferred.length + result.clashes.length + result.failed.length;
  const done = result.transferred.length;
  if (done === total) {
    const [only, ...others] = result.transferred;
    if (only && others.length === 0)
      return {
        ok: true,
        message:
          only.name === only.source.name
            ? `${verb.done} “${only.name}” to ${place}.`
            : `${verb.done} “${only.source.name}” to ${place} as “${only.name}”.`,
      } as const;
    const renamed = result.transferred.filter(
      (item) => item.name !== item.source.name,
    ).length;
    return {
      ok: true,
      message: `${verb.done} ${count(total)} to ${place}.${renamed ? ` ${renamed === 1 ? "1 got a new name" : `${renamed.toLocaleString()} got new names`} because the name was taken.` : ""}`,
    } as const;
  }
  const head = done
    ? `${verb.done} ${done.toLocaleString()} of ${count(total)} to ${place}.`
    : `Nothing was ${verb.none} to ${place}.`;
  const parts = [head];
  const [clash, ...otherClashes] = result.clashes;
  if (clash)
    parts.push(
      otherClashes.length
        ? `${count(result.clashes.length)} have names already used there.`
        : `“${clash.name}” is already there.`,
    );
  const [first, ...rest] = result.failed;
  if (first)
    parts.push(
      `“${first.source.name}”: ${first.reason}${
        rest.length
          ? ` ${rest.length === 1 ? "1 more item" : `${rest.length.toLocaleString()} more items`} also failed.`
          : ""
      }`,
    );
  return { ok: false, message: parts.join(" ") } as const;
}

export const TransferResult = { run, merge, unfinished, describe } as const;
