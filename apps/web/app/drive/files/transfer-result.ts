import type { TransferReceipt } from "@nimbus/api/transfer-receipt";
import { trpcErrorCode } from "@/lib/trpc-error";
import { BulkResult } from "./bulk-result";
import { RunningTransfers } from "./running-transfers";
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

/**
 * What the server answers for one item: transferred, its name was taken, or it changed on disk
 * but something after that failed, so what carried over is not known.
 */
export type TransferOutcome =
  | {
      kind: "transferred";
      name: string;
      path: string;
      receipt: TransferReceipt;
    }
  | { kind: "clash"; name: string; suggestion: string }
  | { kind: "unknown"; message: string };

/** What a move or copy of several items did to each one. */
export type TransferResult = {
  operation: TransferOperation;
  destination: string;
  transferred: Transferred[];
  clashes: TransferClash[];
  /** Clashing items the person chose to leave where they are. */
  skipped: TransferClash[];
  failed: TransferFailure[];
  /** Items a move left alone because they are in the destination already. */
  alreadyThere: FileEntry[];
  /**
   * Items whose request may have been carried out, but whose answer was lost and could not be
   * learned later: Nimbus does not know whether they moved.
   */
  unconfirmed: FileEntry[];
};

/** Errors that do not say the request was refused: it may still have been carried out. */
const unsure = new Set([
  "INTERNAL_SERVER_ERROR",
  "TIMEOUT",
  "CLIENT_CLOSED_REQUEST",
  "BAD_GATEWAY",
  "SERVICE_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
]);

/**
 * Whether `error` leaves a request's outcome unknown. Only an explicit refusal from the server
 * says nothing happened; a lost answer or an unexpected failure may follow a change that was
 * carried out, so nothing about it can be claimed.
 */
export const outcomeUnknown = (error: unknown) => {
  const code = trpcErrorCode(error);
  return code === undefined || unsure.has(code);
};

/**
 * Transfer every item, a bounded number at a time (see `BulkResult.each`). An item the server
 * did not explicitly refuse, but did not answer for either, such as one whose answer was lost
 * or that failed partway, is not counted as failed, since it may have been carried out: it is
 * `unconfirmed`, and never sent again. Nothing could report the transfer, or offer its Undo,
 * once the page is gone, so leaving, reloading or signing out asks first while it runs (see
 * `LeaveGuard`).
 */
async function run(
  operation: TransferOperation,
  destination: string,
  items: readonly FileEntry[],
  transfer: (item: FileEntry) => Promise<TransferOutcome>,
  {
    hold = () => () => undefined,
    watched = () => false,
    concurrency = 16,
  }: {
    /** Holds the page while the transfer runs; returns what releases it (see `LeaveGuard`). */
    hold?: () => () => void;
    /** Whether something on screen shows the transfer running (see `RunningTransfers`). */
    watched?: () => boolean;
    concurrency?: number;
  } = {},
): Promise<TransferResult> {
  const result: TransferResult = {
    operation,
    destination,
    transferred: [],
    clashes: [],
    skipped: [],
    failed: [],
    alreadyThere: [],
    unconfirmed: [],
  };
  const release = hold();
  const finish = RunningTransfers.start({
    verb: operation === "move" ? "Moving" : "Copying",
    items,
    destination,
    watched,
  });
  try {
    await BulkResult.each(
      items,
      async (source) => {
        try {
          const outcome = await transfer(source);
          if (outcome.kind === "unknown") result.unconfirmed.push(source);
          else if (outcome.kind === "clash")
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
          if (outcomeUnknown(error)) result.unconfirmed.push(source);
          else
            result.failed.push({ source, reason: BulkResult.reasonOf(error) });
        }
      },
      concurrency,
    );
  } finally {
    finish();
    release();
  }
  return result;
}

export const TransferResult = { run } as const;
