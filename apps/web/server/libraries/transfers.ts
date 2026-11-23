/**
 * Files being sent to paired devices in chunks, and what can end them. A change that may take
 * a transfer's right away marks the transfers it touches: a disconnected device stops its own at
 * once, and a changed or deleted library has its transfers checked in full before their next
 * chunk. Only transfers under way are tracked; nothing is kept once the last one ends.
 *
 * Under the supervisor, a transfer may be sent by an older server that is draining while the
 * change happens on the newer one, so each signal also goes to `relay`, which passes it to
 * every other server, where `apply` delivers it.
 */
export type Transfer = {
  readonly deviceId: string;
  readonly libraryId: string;
  /** Why the rest may not be sent, once something ended it. */
  stopped: string | null;
  /** Whether something changed that its next chunk must check in full. */
  recheck: boolean;
};

const active = new Set<Transfer>();

/** What ended or changed, as one server tells the others. */
export type TransferSignal =
  | { kind: "devices-ended"; deviceIds: string[] }
  | { kind: "library-deleted"; libraryId: string }
  | { kind: "library-changed"; libraryId: string };

/** Where signals go besides this process's own transfers; nowhere on a server of its own. */
let relay: (signal: TransferSignal) => void = () => undefined;

const disconnected =
  "The device was disconnected from Nimbus, so the transfer was stopped.";
const deleted = "The library was deleted, so the transfer was stopped.";

function apply(signal: TransferSignal) {
  switch (signal.kind) {
    case "devices-ended": {
      const ended = new Set(signal.deviceIds);
      for (const transfer of active)
        if (ended.has(transfer.deviceId)) transfer.stopped = disconnected;
      return;
    }
    case "library-deleted":
      for (const transfer of active)
        if (transfer.libraryId === signal.libraryId) transfer.stopped = deleted;
      return;
    case "library-changed":
      for (const transfer of active)
        if (transfer.libraryId === signal.libraryId) transfer.recheck = true;
      return;
  }
}

function signal(raised: TransferSignal) {
  apply(raised);
  relay(raised);
}

export const Transfers = {
  /** Track a transfer to `deviceId` from library `libraryId` until `end` is called. */
  begin(deviceId: string, libraryId: string) {
    const transfer: Transfer = {
      deviceId,
      libraryId,
      stopped: null,
      recheck: false,
    };
    active.add(transfer);
    return { transfer, end: () => void active.delete(transfer) };
  },

  /** Devices `deviceIds` were disconnected: their transfers stop. */
  devicesEnded(deviceIds: readonly string[]) {
    signal({ kind: "devices-ended", deviceIds: [...deviceIds] });
  },

  /** Library `libraryId` was deleted: its transfers stop. */
  libraryDeleted(libraryId: string) {
    signal({ kind: "library-deleted", libraryId });
  },

  /** Library `libraryId`'s folders or title changed: its transfers check in full. */
  libraryChanged(libraryId: string) {
    signal({ kind: "library-changed", libraryId });
  },

  /** A signal from another server: it reaches this process's transfers only. */
  apply,

  /** Pass every signal raised here to `send` as well, for the other servers. */
  relayTo(send: (signal: TransferSignal) => void) {
    relay = send;
  },

  /** Transfers being tracked, for tests. */
  get size() {
    return active.size;
  },
} as const;
