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

/** What a move or copy of several items did to each one. */
export type TransferResult = {
  operation: TransferOperation;
  destination: string;
  transferred: Transferred[];
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
  transfer: (
    item: FileEntry,
  ) => Promise<{ name: string; path: string; receipt: TransferReceipt }>,
  concurrency = 16,
): Promise<TransferResult> {
  const result: TransferResult = {
    operation,
    destination,
    transferred: [],
    failed: [],
  };
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      const source = items[index];
      if (!source) continue;
      try {
        result.transferred.push({ source, ...(await transfer(source)) });
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
  const total = result.transferred.length + result.failed.length;
  const [first, ...rest] = result.failed;
  if (!first) {
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
  const more = rest.length
    ? ` ${rest.length === 1 ? "1 more item" : `${rest.length.toLocaleString()} more items`} also failed.`
    : "";
  const head = result.transferred.length
    ? `${verb.done} ${result.transferred.length.toLocaleString()} of ${count(total)} to ${place}.`
    : `Nothing was ${verb.none} to ${place}.`;
  return {
    ok: false,
    message: `${head} “${first.source.name}”: ${first.reason}${more}`,
  } as const;
}

export const TransferResult = { run, describe } as const;
