import type { RefusalReason } from "../drop-target";

/**
 * How the picker shows a folder that cannot take the items. Kept apart from the drop rules,
 * which drags need at once, so pages load these words only with the picker.
 */

/** A few words beside a folder that cannot take the items, as the picker lists it. */
const labels: Record<RefusalReason, string> = {
  "read-only": "Read-only",
  itself: "The item itself",
  "inside-itself": "Inside the item",
  "already-there": "Already here",
};

/**
 * Whether a refused folder can still be opened to reach folders inside it: one the account
 * can only view may lead to writable ones; an item and what lies inside it never do.
 */
const leadsOn = (reason: RefusalReason) =>
  reason === "read-only" || reason === "already-there";

export const Refusal = { labels, leadsOn } as const;
