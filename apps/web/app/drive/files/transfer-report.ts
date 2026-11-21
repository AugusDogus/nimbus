import { toast, type ToastAction } from "@/lib/toast";
import { queryClient } from "@/lib/trpc";
import { sessionQuery } from "@/lib/session-query";
import { RecentDestinations } from "./destination-picker/recent-destinations";
import { folderLabel } from "./drive-root";
import type { TransferResult } from "./transfer-result";
import { TransferUndo } from "./transfer-undo";
import type { FileEntry } from "./types";

/**
 * What Nimbus says and offers after a move or copy: a summary toast with Undo, Open folder and
 * Keep both for taken names, and the destination remembered under Recent. Loaded once the
 * first transfer finishes, so no page loads it up front.
 */

/** `later`, a retry of some of `earlier`'s items, applied to it: each item counted once. */
function merge(earlier: TransferResult, later: TransferResult): TransferResult {
  const retried = new Set(
    [...later.transferred, ...later.clashes, ...later.failed].map(
      (item) => item.source.path,
    ),
  );
  const keep = <T extends { source: FileEntry }>(items: readonly T[]) =>
    items.filter((item) => !retried.has(item.source.path));
  return {
    ...earlier,
    transferred: [...earlier.transferred, ...later.transferred],
    clashes: [...keep(earlier.clashes), ...later.clashes],
    failed: [...keep(earlier.failed), ...later.failed],
  };
}

/** `result` with its clashes left where they are, as the person chose. */
const skip = (result: TransferResult): TransferResult => ({
  ...result,
  clashes: [],
  skipped: [...result.skipped, ...result.clashes],
});

const count = (n: number) =>
  n === 1 ? "1 item" : `${n.toLocaleString()} items`;
const verbs = {
  move: { done: "Moved", none: "moved" },
  copy: { done: "Copied", none: "copied" },
} as const;

/**
 * A summary for a toast: "Moved 3 items to Archive.", "Copied “a.txt” to Archive as
 * “a (1).txt”.", or with failures "Moved 2 of 3 items to Archive. “b.txt”: reason". The
 * server's reason says what happened to the item and what to do, so nothing more is claimed.
 */
function describe(result: TransferResult) {
  const verb = verbs[result.operation];
  const place = folderLabel(result.destination);
  const total =
    result.transferred.length + result.clashes.length + result.failed.length;
  const done = result.transferred.length;
  const skipped = result.skipped.length
    ? ` Skipped ${count(result.skipped.length)} whose ${result.skipped.length === 1 ? "name was" : "names were"} taken.`
    : "";
  if (done === total && skipped)
    return {
      ok: true,
      message: done
        ? `${verb.done} ${count(done)} to ${place}.${skipped}`
        : `Nothing was ${verb.none} to ${place}.${skipped}`,
    } as const;
  if (done === total) {
    const [only, ...others] = result.transferred;
    if (only && others.length === 0)
      return {
        ok: true,
        message:
          only.name === only.source.name
            ? `${verb.done} “${only.name}” to ${place}.`
            : `${verb.done} “${only.source.name}” to ${place} as “${only.name}”.`,
      } as const;
    const renamed = result.transferred.filter(
      (item) => item.name !== item.source.name,
    ).length;
    return {
      ok: true,
      message: `${verb.done} ${count(total)} to ${place}.${renamed ? ` ${renamed === 1 ? "1 got a new name" : `${renamed.toLocaleString()} got new names`} because the name was taken.` : ""}`,
    } as const;
  }
  const head = done
    ? `${verb.done} ${done.toLocaleString()} of ${count(total)} to ${place}.`
    : `Nothing was ${verb.none} to ${place}.`;
  const parts = [head];
  const [clash, ...otherClashes] = result.clashes;
  if (clash)
    parts.push(
      otherClashes.length
        ? `${count(result.clashes.length)} have names already used there.`
        : `“${clash.name}” is already there.`,
    );
  const [first, ...rest] = result.failed;
  if (first)
    parts.push(
      `“${first.source.name}”: ${first.reason}${
        rest.length
          ? ` ${rest.length === 1 ? "1 more item" : `${rest.length.toLocaleString()} more items`} also failed.`
          : ""
      }`,
    );
  return { ok: false, message: parts.join(" ") } as const;
}

/** What the report's actions do in the page that made the transfer. */
export type ReportHandlers = {
  /** Refresh what the page shows after files changed. */
  refresh: () => void;
  open: (folder: string) => void;
  /** Transfer items again, keeping both where names are taken. */
  keepBoth: (result: TransferResult) => void;
};

/** Undo every transferred item of `result`, say what happened to each, and return that. */
async function undo(result: TransferResult, refresh: () => void) {
  const items = await TransferUndo.run(result);
  refresh();
  const summary = TransferUndo.describe(result, items);
  if (summary.ok) toast.success(summary.message);
  else toast.error(summary.message);
  return summary;
}

/**
 * Toast what a transfer did. Whatever reached the destination can be undone, also after a
 * partial failure; items whose names were taken can be kept beside what is there.
 */
function show(result: TransferResult, handlers: ReportHandlers) {
  const account = queryClient.getQueryData(sessionQuery.queryKey)?.user.id;
  if (result.transferred.length && account)
    RecentDestinations.record(account, result.destination);
  const summary = describe(result);
  const actions: ToastAction[] = [];
  if (result.transferred.length)
    actions.push(
      { label: "Undo", run: () => void undo(result, handlers.refresh) },
      { label: "Open folder", run: () => handlers.open(result.destination) },
    );
  if (result.clashes.length)
    actions.push({ label: "Keep both", run: () => handlers.keepBoth(result) });
  const options = actions.length ? { actions } : undefined;
  if (summary.ok) toast.success(summary.message, options);
  else toast.error(summary.message, options);
}

export const TransferReport = { describe, merge, skip, show, undo } as const;
