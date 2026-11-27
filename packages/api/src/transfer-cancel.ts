/**
 * Transfers a person asked to stop. A client sends a move or copy of several items as one
 * request per item, all under one transfer id it chose; `cancel` stops each of those items not
 * yet carried out, those waiting in the mutation queue and those sent after it included. An
 * item already changed on disk stays changed. Kept in memory, never in the database: a
 * restart ends every request anyway.
 */

/** Thrown where a cancelled transfer stops an item before anything of it was committed. */
export class TransferCancelledError extends Error {
  constructor() {
    super("The transfer was cancelled before this item changed.");
    this.name = "TransferCancelledError";
  }
}

type Entry = { controller: AbortController; active: number };

const entries = new Map<string, Entry>();
/** How long a cancelled transfer refuses items still arriving, such as requests sent just before. */
const remembered = 10 * 60_000;

const keyOf = (actor: string, transfer: string) => `${actor}\n${transfer}`;

function entryOf(key: string) {
  const existing = entries.get(key);
  if (existing) return existing;
  const created: Entry = { controller: new AbortController(), active: 0 };
  entries.set(key, created);
  return created;
}

/** Forget an idle entry: at once while it runs on, or after a while once cancelled. */
function settle(key: string, entry: Entry) {
  if (entry.active > 0) return;
  if (!entry.controller.signal.aborted) {
    entries.delete(key);
    return;
  }
  setTimeout(() => {
    if (entries.get(key) === entry && entry.active === 0) entries.delete(key);
  }, remembered).unref();
}

/**
 * Run one item of `actor`'s transfer `transfer` with its signal, which aborts once the
 * transfer is cancelled. Without a transfer id, as WebDAV and older clients send, nothing can
 * cancel it.
 */
async function within<T>(
  actor: string,
  transfer: string | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (transfer === undefined) return run(undefined);
  const key = keyOf(actor, transfer);
  const entry = entryOf(key);
  entry.active++;
  try {
    return await run(entry.controller.signal);
  } finally {
    entry.active--;
    settle(key, entry);
  }
}

/** Stop `actor`'s transfer `transfer`: every item of it not yet changed stays as it is. */
function cancel(actor: string, transfer: string) {
  const key = keyOf(actor, transfer);
  const entry = entryOf(key);
  if (entry.controller.signal.aborted) return;
  entry.controller.abort();
  settle(key, entry);
}

/** Throw `TransferCancelledError` once `signal` has aborted. */
function check(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new TransferCancelledError();
}

export const TransferCancel = { within, cancel, check } as const;
