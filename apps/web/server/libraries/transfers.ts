/**
 * Files being sent to paired devices in chunks, and what can end them. A change that may take
 * a transfer's right away marks the transfers it touches: a disconnected device stops its own at
 * once, and a changed or deleted library has its transfers checked in full before their next
 * chunk. Only transfers under way are tracked; nothing is kept once the last one ends.
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

const disconnected =
  "The device was disconnected from Nimbus, so the transfer was stopped.";
const deleted = "The library was deleted, so the transfer was stopped.";

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
    const ended = new Set(deviceIds);
    for (const transfer of active)
      if (ended.has(transfer.deviceId)) transfer.stopped = disconnected;
  },

  /** Library `libraryId` was deleted: its transfers stop. */
  libraryDeleted(libraryId: string) {
    for (const transfer of active)
      if (transfer.libraryId === libraryId) transfer.stopped = deleted;
  },

  /** Library `libraryId`'s folders or title changed: its transfers check in full. */
  libraryChanged(libraryId: string) {
    for (const transfer of active)
      if (transfer.libraryId === libraryId) transfer.recheck = true;
  },

  /** Transfers being tracked, for tests. */
  get size() {
    return active.size;
  },
} as const;
