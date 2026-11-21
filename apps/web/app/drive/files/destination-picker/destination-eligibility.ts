import type { Permission } from "@nimbus/api/drive-store";
import type { TransferOperation } from "../transfer-result";

/** A folder offered as a destination, with what the server says the account may do in it. */
export type DestinationFolder = { path: string; permission: Permission };

/**
 * Why a folder cannot receive the items:
 * - `self`: it is one of the items;
 * - `inside`: it is inside one of the items, which cannot hold itself;
 * - `already-here`: every item is already in it, so moving there would change nothing;
 * - `read-only`: the account cannot add to it.
 */
export type BlockedReason = "self" | "inside" | "already-here" | "read-only";

export type Eligibility =
  | { kind: "eligible" }
  /**
   * `navigable`: the folder can still be opened to reach folders inside it. A read-only folder
   * can lead to writable ones; an item and what is inside it never lead anywhere usable.
   */
  | { kind: "blocked"; reason: BlockedReason; navigable: boolean };

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

const within = (folder: string, path: string) =>
  folder === "" || path === folder || path.startsWith(`${folder}/`);

/** Whether `folder` can receive `sources` by `operation`, and if not, why. */
function of(
  operation: TransferOperation,
  sources: readonly { path: string }[],
  folder: DestinationFolder,
): Eligibility {
  for (const source of sources) {
    if (folder.path === source.path)
      return { kind: "blocked", reason: "self", navigable: false };
    if (source.path !== "" && within(source.path, folder.path))
      return { kind: "blocked", reason: "inside", navigable: false };
  }
  if (
    operation === "move" &&
    sources.length > 0 &&
    sources.every((source) => parentOf(source.path) === folder.path)
  )
    return { kind: "blocked", reason: "already-here", navigable: true };
  if (folder.permission === "read")
    return { kind: "blocked", reason: "read-only", navigable: true };
  return { kind: "eligible" };
}

/** A short label shown beside a folder that cannot be chosen. */
const labels: Record<BlockedReason, string> = {
  self: "The item itself",
  inside: "Inside the item",
  "already-here": "Already here",
  "read-only": "Read-only",
};

/** A sentence saying why the browsed folder cannot be chosen, for the footer. */
function explain(reason: BlockedReason, count: number) {
  const items = count === 1 ? "this item" : "these items";
  switch (reason) {
    case "self":
      return `This is ${count === 1 ? "the item" : "one of the items"} itself. Choose another folder.`;
    case "inside":
      return `This folder is inside ${count === 1 ? "the item" : "one of the items"}. Choose a folder outside it.`;
    case "already-here":
      return `${count === 1 ? "This item is" : "These items are"} already here. Choose another folder.`;
    case "read-only":
      return `You can only view this folder, so ${items} cannot go here. Open a folder inside it or choose another.`;
  }
}

export const DestinationEligibility = { of, labels, explain } as const;
