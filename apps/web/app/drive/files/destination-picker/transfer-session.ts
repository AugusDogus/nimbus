import type {
  TransferClash,
  TransferFailure,
  TransferOperation,
  TransferResult,
  Transferred,
} from "../transfer-result";
import type { FileEntry } from "../types";

/** An item still to transfer, and what happened to it last. */
type Open =
  | { kind: "untried"; source: FileEntry }
  | { kind: "clash"; destination: string; clash: TransferClash }
  | { kind: "failed"; destination: string; failure: TransferFailure };

/** An item left where it is on purpose: its name was taken and skipped, or it was there. */
type Settled =
  | { kind: "skipped"; destination: string; clash: TransferClash }
  | { kind: "already-there"; destination: string; source: FileEntry };

/**
 * Everything one picker did, across every destination it was pointed at. Items that reached a
 * destination are kept apart from the items still to transfer: only these are tried again,
 * and nothing that happens later removes a completed transfer, or its receipt, except Undo.
 */
export type TransferSession = {
  operation: TransferOperation;
  /** Each item that reached a destination, with its receipt, in the order they arrived. */
  completed: readonly { destination: string; item: Transferred }[];
  /** Items still to transfer, by path before the transfer. */
  open: ReadonlyMap<string, Open>;
  settled: readonly Settled[];
  /** Destinations in the order they were first used. */
  destinations: readonly string[];
};

/** A session about to transfer `entries`. */
const start = (
  operation: TransferOperation,
  entries: readonly FileEntry[],
): TransferSession => ({
  operation,
  completed: [],
  open: new Map(
    entries.map((source) => [source.path, { kind: "untried", source }]),
  ),
  settled: [],
  destinations: [],
});

/**
 * `session` once the server answered `result`, a transfer of some of its open items. Items that
 * arrived leave the open items for the completed ones; the others stay open with their outcome.
 */
function record(
  session: TransferSession,
  result: TransferResult,
): TransferSession {
  const { destination } = result;
  const open = new Map(session.open);
  for (const item of result.transferred) open.delete(item.source.path);
  for (const clash of result.clashes)
    open.set(clash.source.path, { kind: "clash", destination, clash });
  for (const failure of result.failed)
    open.set(failure.source.path, { kind: "failed", destination, failure });
  const settled: Settled[] = [
    ...result.skipped.map((clash): Settled => ({
      kind: "skipped",
      destination,
      clash,
    })),
    ...result.alreadyThere.map((source): Settled => ({
      kind: "already-there",
      destination,
      source,
    })),
  ];
  for (const item of settled)
    open.delete(
      item.kind === "skipped" ? item.clash.source.path : item.source.path,
    );
  return {
    ...session,
    completed: [
      ...session.completed,
      ...result.transferred.map((item) => ({ destination, item })),
    ],
    open,
    settled: [...session.settled, ...settled],
    destinations: session.destinations.includes(destination)
      ? session.destinations
      : [...session.destinations, destination],
  };
}

/** `session` with the open clashes in `clashes` left where they are, as the person chose. */
function skip(
  session: TransferSession,
  clashes: readonly TransferClash[],
): TransferSession {
  const open = new Map(session.open);
  const settled: Settled[] = [];
  for (const clash of clashes) {
    const current = open.get(clash.source.path);
    if (current?.kind !== "clash") continue;
    open.delete(clash.source.path);
    settled.push({ kind: "skipped", destination: current.destination, clash });
  }
  return { ...session, open, settled: [...session.settled, ...settled] };
}

/**
 * `session` once Undo put `items` back where they were, as the person asked: the session
 * neither reports nor transfers them again.
 */
function undone(
  session: TransferSession,
  items: readonly Transferred[],
): TransferSession {
  const ids = new Set(items.map((item) => item.receipt.id));
  return {
    ...session,
    completed: session.completed.filter(
      ({ item }) => !ids.has(item.receipt.id),
    ),
  };
}

/** The items still to transfer. */
const pending = (session: TransferSession): FileEntry[] =>
  [...session.open.values()].map((item) =>
    item.kind === "untried"
      ? item.source
      : item.kind === "clash"
        ? item.clash.source
        : item.failure.source,
  );

/** Everything that reached a destination and has not been undone. */
const transferred = (session: TransferSession): Transferred[] =>
  session.completed.map(({ item }) => item);

/**
 * One result per destination, in the order destinations were first used: what reached it, and
 * the outcome there of each item that did not. Items never tried are in none.
 */
function results(session: TransferSession): TransferResult[] {
  const byDestination = new Map<string, TransferResult>(
    session.destinations.map((destination) => [
      destination,
      {
        operation: session.operation,
        destination,
        transferred: [],
        clashes: [],
        skipped: [],
        failed: [],
        alreadyThere: [],
      },
    ]),
  );
  for (const { destination, item } of session.completed)
    byDestination.get(destination)?.transferred.push(item);
  for (const item of session.open.values()) {
    if (item.kind === "untried") continue;
    const result = byDestination.get(item.destination);
    if (item.kind === "clash") result?.clashes.push(item.clash);
    else result?.failed.push(item.failure);
  }
  for (const item of session.settled) {
    const result = byDestination.get(item.destination);
    if (item.kind === "skipped") result?.skipped.push(item.clash);
    else result?.alreadyThere.push(item.source);
  }
  return [...byDestination.values()].filter(
    (result) =>
      result.transferred.length +
        result.clashes.length +
        result.skipped.length +
        result.failed.length +
        result.alreadyThere.length >
      0,
  );
}

export const TransferSession = {
  start,
  record,
  skip,
  undone,
  pending,
  transferred,
  results,
} as const;
