import type { BigIntStats } from "node:fs";
import {
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { isFsError } from "./safe-path";

/**
 * What a move or copy hands back for each item it transferred, so the account that made it
 * can undo it: where the item was and where it ended up, which operation, who made it, and
 * which item it was. Undo sends receipts back; the server then checks each one again (see
 * `undoTransfer` in file-operations.ts) and changes only what still matches it.
 *
 * Receipts are sealed with a key derived from the server secret and bound to the account, so
 * nobody can fabricate one or use another account's. They grant nothing by themselves: undoing
 * is checked like any other move or trash, with the account's current permissions.
 *
 * They are also bound to one run of the server (`boot`): an item's identity includes its inode
 * number, which Unraid user shares hand out again when the array is mounted again, so a
 * restart ends every receipt issued before it.
 */
export type TransferReceipt = {
  /** Distinct for every receipt. */
  id: string;
  /** The run of the server that issued it. */
  boot: string;
  operation: "move" | "copy";
  /** The account that made the transfer, the only one that can undo it. */
  actor: string;
  /** The item's path before a move, or the copied item's path for a copy. */
  from: string;
  /** Where the moved item or the new copy ended up. */
  to: string;
  /** The item at `to` when the transfer finished; see `ItemIdentity`. */
  identity: string;
  issuedAt: number;
  seal: string;
};

/** How long a receipt can be undone. Undo is offered right after the transfer. */
export const RECEIPT_LIFETIME_MS = 60 * 60 * 1000;

const sealedFields = z.object({
  id: z.string().min(1).max(100),
  boot: z.string().min(1).max(100),
  operation: z.enum(["move", "copy"]),
  actor: z.string().min(1).max(200),
  from: z.string().max(4096),
  to: z.string().min(1).max(4096),
  identity: z.string().min(1).max(200),
  issuedAt: z.number().int().nonnegative(),
});

/** A receipt as clients send it back. The seal is checked by `verify`, not here. */
const schema = sealedFields.extend({ seal: z.string().regex(/^[\da-f]{64}$/) });

/**
 * The server secret when one is configured, as every production server has (start.ts refuses
 * to run without it); otherwise a key for this process only.
 */
const secret =
  process.env.BETTER_AUTH_SECRET || randomBytes(32).toString("hex");
const key = Buffer.from(
  hkdfSync(
    "sha256",
    secret,
    new Uint8Array(0),
    "nimbus/transfer-receipt/v2",
    32,
  ),
);

/** This run of the server. */
const currentBoot = randomUUID();

const sealOf = (fields: Omit<TransferReceipt, "seal">) =>
  createHmac("sha256", key)
    .update(
      JSON.stringify([
        fields.id,
        fields.boot,
        fields.operation,
        fields.actor,
        fields.from,
        fields.to,
        fields.identity,
        fields.issuedAt,
      ]),
    )
    .digest("hex");

function issue(
  fields: Omit<TransferReceipt, "id" | "boot" | "seal" | "issuedAt">,
  now = Date.now(),
  /** Another run's id, for tests of receipts that outlived their run. */
  boot: string = currentBoot,
): TransferReceipt {
  const unsealed = { ...fields, id: randomUUID(), boot, issuedAt: now };
  return { ...unsealed, seal: sealOf(unsealed) };
}

export type ReceiptRefusal =
  /** Not sealed by this server, or changed since. */
  | "forged"
  /** Sealed for another account. */
  | "other-account"
  /** Issued before the server restarted. */
  | "restarted"
  /** Older than `RECEIPT_LIFETIME_MS`. */
  | "expired";

function verify(
  receipt: TransferReceipt,
  actor: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: ReceiptRefusal } {
  const expected = Buffer.from(sealOf(receipt), "hex");
  const received = Buffer.from(receipt.seal, "hex");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return { ok: false, reason: "forged" };
  if (receipt.actor !== actor) return { ok: false, reason: "other-account" };
  if (receipt.boot !== currentBoot) return { ok: false, reason: "restarted" };
  if (now - receipt.issuedAt > RECEIPT_LIFETIME_MS || receipt.issuedAt > now)
    return { ok: false, reason: "expired" };
  return { ok: true };
}

export const TransferReceipt = { schema, issue, verify } as const;

type IdentityStats = Pick<
  BigIntStats,
  "dev" | "ino" | "ctimeNs" | "mtimeNs" | "size" | "isDirectory" | "isFile"
>;
type StatAt = (absolute: string) => Promise<IdentityStats>;
const statAt: StatAt = (absolute) => lstat(absolute, { bigint: true });

/**
 * Which item a receipt is about, recognised later at the path it was moved or copied to.
 *
 * Birth times cannot name items in production: Unraid user shares (shfs, a FUSE filesystem)
 * report none, for files or folders, so whatever names an item must work without them. An
 * identity is the item's device and inode number, its change time and its modification time
 * (and a file's size), all read after the transfer, since a rename itself moves the change
 * time.
 *
 * The change time is the core of it: no program can set it, and writing, truncating,
 * replacing, renaming, linking, chmod and setting the modification time all move it. A file
 * with the same name, size and modification time put in the item's place still has another
 * change time. The inode number tells an item from one put in its place within the same
 * clock tick. Inode numbers hold only while a filesystem stays mounted (shfs hands them out
 * again on every mount), which is why receipts end when the server restarts.
 *
 * - `exact`: everything matches. Any change since, to the item or its entries, counts.
 * - `entries` (moving a folder back): the folder also counts as itself when its entries changed
 *   since and nothing else did. Adding, removing or renaming an entry sets a folder's change
 *   and modification times to the same later value; a chmod or rename of the folder moves the
 *   change time alone, and a folder created in its place has another inode number.
 *
 * Copies are trashed only on `exact`, so a copy someone has added to is never trashed by Undo.
 * Changes deeper inside a folder do not touch its own times and are not seen.
 */
const identityOf = (stats: IdentityStats) =>
  [
    "v2",
    stats.isDirectory() ? "dir" : "file",
    stats.dev,
    stats.ino,
    stats.ctimeNs,
    stats.mtimeNs,
    stats.isDirectory() ? BigInt(0) : stats.size,
  ].join(":");

const parse = (identity: string) => {
  const parts = /^v2:(dir|file):(\d+):(\d+):(\d+):(\d+):(\d+)$/.exec(identity);
  if (!parts) return null;
  return {
    kind: parts[1],
    dev: parts[2],
    ino: parts[3],
    ctime: BigInt(parts[4] ?? "0"),
    mtime: BigInt(parts[5] ?? "0"),
    size: parts[6],
  };
};

const identityAt = async (absolute: string, stat: StatAt = statAt) =>
  identityOf(await stat(absolute));

export type IdentityMatch = "same" | "changed" | "missing";

/** How much change an item may have had and still count as itself; see `identityOf`. */
export type IdentityTolerance = "exact" | "entries";

/** Whether the item named `identity` is at `absolute`, something else is, or nothing is. */
async function matchAt(
  absolute: string,
  identity: string,
  tolerance: IdentityTolerance = "exact",
  stat: StatAt = statAt,
): Promise<IdentityMatch> {
  let stats: IdentityStats;
  try {
    stats = await stat(absolute);
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR"))
      return "missing";
    throw error;
  }
  if (!stats.isDirectory() && !stats.isFile()) return "changed";
  const current = identityOf(stats);
  if (current === identity) return "same";
  const recorded = parse(identity);
  const now = parse(current);
  if (
    tolerance === "entries" &&
    recorded !== null &&
    now !== null &&
    recorded.kind === "dir" &&
    now.kind === "dir" &&
    now.dev === recorded.dev &&
    now.ino === recorded.ino &&
    now.ctime === now.mtime &&
    now.ctime > recorded.ctime
  )
    return "same";
  return "changed";
}

export const ItemIdentity = { identityAt, matchAt } as const;
