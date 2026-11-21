import type { TransferReceipt } from "@nimbus/api/transfer-receipt";
import { BulkResult } from "./bulk-result";
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

/**
 * An item left where it was because its name is taken in the destination. `suggestion` is a
 * numbered name that was free when the server checked.
 */
export type TransferClash = {
  source: FileEntry;
  name: string;
  suggestion: string;
};

/** What the server answers for one item: transferred, or its name was taken. */
export type TransferOutcome =
  | {
      kind: "transferred";
      name: string;
      path: string;
      receipt: TransferReceipt;
    }
  | { kind: "clash"; name: string; suggestion: string };

/** What a move or copy of several items did to each one. */
export type TransferResult = {
  operation: TransferOperation;
  destination: string;
  transferred: Transferred[];
  clashes: TransferClash[];
  /** Clashing items the person chose to leave where they are. */
  skipped: TransferClash[];
  failed: TransferFailure[];
};

/** Transfer every item, a bounded number at a time (see `BulkResult.each`). */
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
    skipped: [],
    failed: [],
  };
  await BulkResult.each(
    items,
    async (source) => {
      try {
        const outcome = await transfer(source);
        if (outcome.kind === "clash")
          result.clashes.push({
            source,
            name: outcome.name,
            suggestion: outcome.suggestion,
          });
        else
          result.transferred.push({
            source,
            name: outcome.name,
            path: outcome.path,
            receipt: outcome.receipt,
          });
      } catch (error) {
        result.failed.push({ source, reason: BulkResult.reasonOf(error) });
      }
    },
    concurrency,
  );
  return result;
}

export const TransferResult = { run } as const;
