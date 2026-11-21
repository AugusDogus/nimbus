import { dismissToast, toast } from "@/lib/toast";
import { queryClient, trpc } from "@/lib/trpc";
import { folderName } from "./destination-picker/folder-name";
import type { FileEntry } from "./types";

/** One transfer or Undo that has been sent and not yet answered. */
type Running = {
  verb: "Moving" | "Copying" | "Undoing";
  items: readonly Pick<FileEntry, "name">[];
  /** Where the items go; none for an Undo, which sends each back where it came from. */
  destination: string | null;
  /** Whether something on screen already shows it, such as the picker that sent it. */
  watched: () => boolean;
  since: number;
};

/** The one toast that lists what is still running, so several never push each other out. */
const entryId = "transfers-running";
/** How long a transfer runs before it is listed: quick ones only show their report. */
const after = 1000;

const running = new Set<Running>();
let shown = false;
let ticking: ReturnType<typeof setInterval> | null = null;

const count = (n: number) =>
  n === 1 ? "1 item" : `${n.toLocaleString()} items`;

function describe(listed: readonly Running[]) {
  const [only, ...others] = listed;
  if (!only) return "";
  if (others.length) {
    const items = listed.reduce(
      (total, entry) => total + entry.items.length,
      0,
    );
    return `Still moving, copying or putting back ${count(items)}…`;
  }
  const [item, ...more] = only.items;
  const subject =
    item && more.length === 0 ? `“${item.name}”` : count(only.items.length);
  if (only.destination === null) return `${only.verb} ${subject}…`;
  const top = queryClient.getQueryData(trpc.access.me.queryKey())?.top ?? "";
  return `${only.verb} ${subject} to ${folderName(only.destination, top)}…`;
}

/** Show, update or close the entry for what has run longer than `after` unwatched. */
function refresh() {
  const now = Date.now();
  const listed = [...running].filter(
    (entry) => now - entry.since >= after && !entry.watched(),
  );
  if (listed.length) {
    toast.loading(describe(listed), entryId);
    shown = true;
  } else if (shown) {
    dismissToast(entryId);
    shown = false;
  }
  if (running.size === 0 && ticking !== null) {
    clearInterval(ticking);
    ticking = null;
  }
}

/**
 * Transfers and Undos sent and not yet answered, shown in one "Moving 3 items to Archive…"
 * entry once one has run for a second with nothing else on screen saying so, as when its
 * picker was closed or it came from a drop or a menu. However long a request takes (a large
 * copy can take minutes), something says it is under way until its report replaces it.
 */
export const RunningTransfers = {
  /** List `entry` while it runs; call the returned function once it has its answer. */
  start(entry: Omit<Running, "since">): () => void {
    const listed: Running = { ...entry, since: Date.now() };
    running.add(listed);
    // A picker closing, or a second passing, changes what is shown: checked twice a second.
    ticking ??= setInterval(refresh, 500);
    return () => {
      if (running.delete(listed)) refresh();
    };
  },
} as const;
