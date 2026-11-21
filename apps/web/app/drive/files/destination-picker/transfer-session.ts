import type {
  TransferClash,
  TransferFailure,
  TransferOperation,
  TransferResult,
  Transferred,
} from "../transfer-result";
import type { FileEntry } from "../types";

/** What happened to one item last, and where. */
type Outcome =
  | { kind: "transferred"; item: Transferred }
  | { kind: "clash"; clash: TransferClash }
  | { kind: "skipped"; clash: TransferClash }
  | { kind: "failed"; failure: TransferFailure }
  | { kind: "already-there"; source: FileEntry };

/**
 * Everything one picker did, item by item, across every destination it was pointed at: an item
 * moved after its name clashed elsewhere counts where it went, and one retried after a failure
 * counts as the retry went. Reported when the picker closes, one report per destination, each
 * with Undo for what reached it.
 */
export type TransferSession = {
  operation: TransferOperation;
  /** By the item's path before the transfer, in the order items were first transferred. */
  items: ReadonlyMap<string, { destination: string; outcome: Outcome }>;
};

const start = (operation: TransferOperation): TransferSession => ({
  operation,
  items: new Map(),
});

/** `session` with what `result` did to its items, replacing what was known of them. */
function record(
  session: TransferSession,
  result: TransferResult,
): TransferSession {
  const items = new Map(session.items);
  const set = (source: FileEntry, outcome: Outcome) =>
    items.set(source.path, { destination: result.destination, outcome });
  for (const item of result.transferred)
    set(item.source, { kind: "transferred", item });
  for (const clash of result.clashes)
    set(clash.source, { kind: "clash", clash });
  for (const clash of result.skipped)
    set(clash.source, { kind: "skipped", clash });
  for (const failure of result.failed)
    set(failure.source, { kind: "failed", failure });
  for (const source of result.alreadyThere)
    set(source, { kind: "already-there", source });
  return { ...session, items };
}

/** `session` without the transfers in `result`, undone from the picker meanwhile. */
function undone(
  session: TransferSession,
  result: TransferResult,
): TransferSession {
  const items = new Map(session.items);
  for (const item of result.transferred) items.delete(item.source.path);
  return { ...session, items };
}

/** One result per destination, in the order destinations were first used. */
function results(session: TransferSession): TransferResult[] {
  const byDestination = new Map<string, TransferResult>();
  for (const { destination, outcome } of session.items.values()) {
    let result = byDestination.get(destination);
    if (!result) {
      result = {
        operation: session.operation,
        destination,
        transferred: [],
        clashes: [],
        skipped: [],
        failed: [],
        alreadyThere: [],
      };
      byDestination.set(destination, result);
    }
    switch (outcome.kind) {
      case "transferred":
        result.transferred.push(outcome.item);
        break;
      case "clash":
        result.clashes.push(outcome.clash);
        break;
      case "skipped":
        result.skipped.push(outcome.clash);
        break;
      case "failed":
        result.failed.push(outcome.failure);
        break;
      case "already-there":
        result.alreadyThere.push(outcome.source);
    }
  }
  return [...byDestination.values()];
}

export const TransferSession = { start, record, undone, results } as const;
