import { CodeLoad } from "@/lib/code-load";

/**
 * The code that carries out a move or copy and the code that reports it, which load on demand.
 * Both are loaded before a transfer sends anything, so a transfer that starts can always be
 * reported. `prepare` starts loading them as a drag starts, a menu opens or items are
 * selected, so the transfer itself waits less.
 */
const load = () =>
  CodeLoad.load(() =>
    Promise.all([import("./transfer-result"), import("./transfer-report")]),
  );

export const TransferCode = {
  load,
  /** Start loading ahead; a failure here is met again, and reported, by `load`. */
  prepare: () => {
    load().catch(() => undefined);
  },
} as const;
