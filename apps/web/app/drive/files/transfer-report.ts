import { toast, type ToastAction } from "@/lib/toast";
import { queryClient, trpc } from "@/lib/trpc";
import { folderName } from "./destination-picker/folder-name";
import { sessionQuery } from "@/lib/session-query";
import { RecentDestinations } from "./destination-picker/recent-destinations";
import type { TransferResult } from "./transfer-result";
import { TransferDetails, type DetailSection } from "./transfer-details";
import { TransferUndo } from "./transfer-undo";
import { fileHref, type FileEntry } from "./types";
import { FolderPath } from "./folder-path";
import { SplitAddress } from "./split/split-address";

/**
 * What Nimbus says and offers after a move or copy: a summary toast with Undo, Open folder and
 * Keep both for taken names, and the destination remembered under Recent. Loaded once the
 * first transfer finishes, so no page loads it up front.
 */

/**
 * `later`, a retry of some of `earlier`'s items, applied to it: each item counted once, as the
 * retry left it. An item the retry may have transferred is no longer an open clash or failure.
 */
function merge(earlier: TransferResult, later: TransferResult): TransferResult {
  const retried = new Set([
    ...[...later.transferred, ...later.clashes, ...later.failed].map(
      (item) => item.source.path,
    ),
    ...later.unconfirmed.map((item) => item.path),
  ]);
  const keep = <T extends { source: FileEntry }>(items: readonly T[]) =>
    items.filter((item) => !retried.has(item.source.path));
  return {
    ...earlier,
    transferred: [...earlier.transferred, ...later.transferred],
    clashes: [...keep(earlier.clashes), ...later.clashes],
    failed: [...keep(earlier.failed), ...later.failed],
    unconfirmed: [...earlier.unconfirmed, ...later.unconfirmed],
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
  move: { done: "Moved", none: "moved", one: "moved", many: "moved" },
  copy: {
    done: "Copied",
    none: "copied",
    one: "was copied",
    many: "were copied",
  },
} as const;

/**
 * "Nimbus could not confirm whether “a.txt” moved. Check Archive.": what to say of items whose
 * answer was lost, without claiming either outcome.
 */
function unconfirmedPart(result: TransferResult, place: string) {
  const verb = verbs[result.operation];
  const [only, ...others] = result.unconfirmed;
  if (!only) return null;
  return others.length
    ? `Nimbus could not confirm whether ${count(result.unconfirmed.length)} ${verb.many}. Check ${place}.`
    : `Nimbus could not confirm whether “${only.name}” ${verb.one}. Check ${place}.`;
}

/**
 * A summary for a toast: "Moved 3 items to Archive.", "Copied “a.txt” to Archive as
 * “a (1).txt”.", or with failures "Moved 2 of 3 items to Archive. “b.txt”: reason". The
 * server's reason says what happened to the item and what to do, so nothing more is claimed.
 */
function describe(result: TransferResult, top = "") {
  const verb = verbs[result.operation];
  const place = folderName(result.destination, top);
  const total =
    result.transferred.length +
    result.clashes.length +
    result.failed.length +
    result.unconfirmed.length;
  const done = result.transferred.length;
  const [stayed, ...alsoStayed] = result.alreadyThere;
  const skipped = `${
    result.skipped.length
      ? ` Skipped ${count(result.skipped.length)} whose ${result.skipped.length === 1 ? "name was" : "names were"} taken.`
      : ""
  }${
    stayed
      ? alsoStayed.length
        ? ` ${result.alreadyThere.length.toLocaleString()} items were already there.`
        : ` “${stayed.name}” was already there.`
      : ""
  }`;
  if (done === total && (result.skipped.length > 0 || (skipped && done === 0)))
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
        message: `${
          only.name === only.source.name
            ? `${verb.done} “${only.name}” to ${place}.`
            : `${verb.done} “${only.source.name}” to ${place} as “${only.name}”.`
        }${skipped}`,
      } as const;
    const renamed = result.transferred.filter(
      (item) => item.name !== item.source.name,
    ).length;
    return {
      ok: true,
      message: `${verb.done} ${count(total)} to ${place}.${renamed ? ` ${renamed === 1 ? "1 got a new name" : `${renamed.toLocaleString()} got new names`} because the name was taken.` : ""}${skipped}`,
    } as const;
  }
  const unsure = unconfirmedPart(result, place);
  // Nothing is said to have stayed while some items may have moved.
  const head = done
    ? `${verb.done} ${done.toLocaleString()} of ${count(total)} to ${place}.`
    : unsure
      ? ""
      : `Nothing was ${verb.none} to ${place}.`;
  const parts = [(head + skipped).trim(), unsure ?? ""].filter(Boolean);
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
  /** Hold the page while an Undo runs (see `LeaveGuard`). */
  hold: () => () => void;
  open: (folder: string) => void;
  /**
   * Open the picker at `result`'s clashes, to rename or keep both; says whether it opened.
   * Absent where no page can show the picker.
   */
  choose?: (result: TransferResult) => boolean;
  /** Transfer the clashing items of each result again, keeping both, and report it once. */
  keepBoth: (results: readonly TransferResult[]) => void;
};

/** The account's top folder, as the page loaded it, which messages call by the root's label. */
const topFolder = () =>
  queryClient.getQueryData(trpc.access.me.queryKey())?.top ?? "";

/**
 * Undo every transferred item of `result` and say what happened to each, with Details listing
 * every item that stayed and why when there are several. Returns that summary with the items
 * that were undone.
 */
async function undo(
  result: TransferResult,
  {
    refresh,
    hold,
    watched,
  }: Pick<ReportHandlers, "refresh" | "hold"> & {
    /** Whether something on screen shows the Undo running, such as the picker's own panel. */
    watched?: () => boolean;
  },
) {
  const items = await TransferUndo.run(result, undefined, { hold, watched });
  refresh();
  const summary = TransferUndo.describe(result, items, topFolder());
  const kept = items.flatMap((item) => (item.kind === "undone" ? [] : [item]));
  if (summary.ok) toast.success(summary.message);
  else
    toast.error(
      summary.message,
      kept.length > 1
        ? {
            actions: [
              {
                label: "Details",
                keepsToast: true,
                run: () =>
                  TransferDetails.open("What stayed", [
                    {
                      summary: summary.message,
                      items: kept.map((item) => item.message),
                    },
                  ]),
              },
            ],
          }
        : undefined,
    );
  // `run` answers once per item, in order.
  const undone = result.transferred.filter(
    (_, index) => items[index]?.kind === "undone",
  );
  return { ...summary, undone };
}

/**
 * A summary of transfers to several destinations, such as one picker's: "Moved 5 items to 3
 * folders.", or with what did not arrive "Moved 4 of 6 items to 3 folders. 1 item could not
 * be moved. 1 item had a name already taken."
 */
function describeAll(results: readonly TransferResult[], top = "") {
  const [first, ...others] = results;
  if (!first || others.length === 0)
    return first
      ? describe(first, top)
      : ({ ok: true, message: "Nothing was changed." } as const);
  const verb = verbs[first.operation];
  const sum = (pick: (result: TransferResult) => readonly unknown[]) =>
    results.reduce((total, result) => total + pick(result).length, 0);
  const done = sum((result) => result.transferred);
  const failed = sum((result) => result.failed);
  const clashes = sum((result) => result.clashes);
  const skipped = sum((result) => result.skipped);
  const already = sum((result) => result.alreadyThere);
  const unsure = sum((result) => result.unconfirmed);
  const total = done + failed + clashes + unsure;
  const reached = results.filter((result) => result.transferred.length);
  const [onlyReached] = reached;
  const where =
    reached.length === 1 && onlyReached
      ? folderName(onlyReached.destination, top)
      : `${reached.length.toLocaleString()} folders`;
  const parts = [
    !done
      ? unsure
        ? ""
        : `Nothing was ${verb.none}.`
      : done === total
        ? `${verb.done} ${count(done)} to ${where}.`
        : `${verb.done} ${done.toLocaleString()} of ${count(total)} to ${where}.`,
  ].filter(Boolean);
  if (unsure)
    parts.push(
      `Nimbus could not confirm whether ${count(unsure)} ${unsure === 1 ? verb.one : verb.many}; see Details for where to check.`,
    );
  if (failed)
    parts.push(
      `${count(failed)} could not be ${verb.none}; see Details for why.`,
    );
  if (clashes)
    parts.push(
      clashes === 1
        ? "1 item had a name already taken."
        : `${count(clashes)} had names already taken.`,
    );
  if (skipped)
    parts.push(
      `Skipped ${count(skipped)} whose ${skipped === 1 ? "name was" : "names were"} taken.`,
    );
  if (already)
    parts.push(
      `${count(already)} ${already === 1 ? "was" : "were"} already there.`,
    );
  return {
    ok: !failed && !clashes && !unsure,
    message: parts.join(" "),
  } as const;
}

/**
 * Each destination's part of a report: its summary, and every item's outcome there, one line
 * each, whatever the mix of outcomes.
 */
function sections(
  results: readonly TransferResult[],
  top = "",
): DetailSection[] {
  return results.map((result) => {
    const verb = verbs[result.operation];
    const place = folderName(result.destination, top);
    return {
      summary: describe(result, top).message,
      items: [
        ...result.transferred.map((item) =>
          item.name === item.source.name
            ? `“${item.name}”: ${verb.none}.`
            : `“${item.source.name}”: ${verb.none} as “${item.name}”.`,
        ),
        ...result.unconfirmed.map(
          (item) =>
            `“${item.name}”: Nimbus could not confirm whether it ${verb.one}. Check ${place}.`,
        ),
        ...result.failed.map(
          (failure) => `“${failure.source.name}”: ${failure.reason}`,
        ),
        ...result.clashes.map(
          (clash) =>
            `“${clash.name}”: the name is already used in ${place}, so it stayed where it was.`,
        ),
        ...result.skipped.map(
          (clash) =>
            `“${clash.name}”: skipped, as its name is taken in ${place}.`,
        ),
        ...result.alreadyThere.map(
          (item) => `“${item.name}”: already in ${place}.`,
        ),
      ],
    };
  });
}

/**
 * Toast what transfers did, one toast for all of `results`, which are one result per
 * destination, such as everything one picker did. Whatever arrived can be undone in one go,
 * also after a partial failure; items whose names were taken can be kept beside what is there.
 * Several destinations are summarised, with Details for each one's part. A report lasts as
 * every toast with actions does (see `Toaster`): one with failures stays until closed, and
 * the time of others is held while Details is open. Once a report is gone it cannot be opened
 * again, though its receipts allow Undo for an hour.
 */
function show(results: readonly TransferResult[], handlers: ReportHandlers) {
  const [first, ...others] = results;
  if (!first) return;
  const account = queryClient.getQueryData(sessionQuery.queryKey)?.user.id;
  const reached = results.filter((result) => result.transferred.length);
  if (account)
    for (const result of reached)
      RecentDestinations.record(account, result.destination);
  const top = topFolder();
  const summary = describeAll(results, top);
  const actions: ToastAction[] = [];
  if (reached.length) {
    const everything: TransferResult = {
      ...first,
      transferred: reached.flatMap((result) => result.transferred),
    };
    actions.push({
      label: "Undo",
      run: () => void undo(everything, handlers),
    });
  }
  // One folder to look in: where items went, or may have gone.
  const [onlyPlace, ...otherPlaces] = results.filter(
    (result) => result.transferred.length || result.unconfirmed.length,
  );
  if (onlyPlace && otherPlaces.length === 0)
    actions.push({
      label: "Open folder",
      run: () => handlers.open(onlyPlace.destination),
    });
  const clashing = results.filter((result) => result.clashes.length);
  if (clashing.length)
    actions.push({
      label: "Keep both",
      run: () => handlers.keepBoth(clashing),
    });
  const [onlyClashing, ...alsoClashing] = clashing;
  const { choose } = handlers;
  if (onlyClashing && alsoClashing.length === 0 && choose) {
    // Only the clashes go to the picker: what moved is this report's to undo.
    const asked: TransferResult = {
      ...onlyClashing,
      transferred: [],
      skipped: [],
      failed: [],
      alreadyThere: [],
      unconfirmed: [],
    };
    actions.push({
      label: onlyClashing.clashes.length === 1 ? "Rename…" : "Choose…",
      // A page that cannot show the picker now leaves the choice in a report again.
      run: () => {
        if (!choose(asked)) show([asked], handlers);
      },
    });
  }
  if (others.length)
    actions.push({
      label: "Details",
      keepsToast: true,
      run: () =>
        TransferDetails.open(
          first.operation === "move" ? "What was moved" : "What was copied",
          sections(results, top),
        ),
    });
  const options = actions.length ? { actions } : undefined;
  if (summary.ok) toast.success(summary.message, options);
  else toast.error(summary.message, options);
}

/**
 * Where "Open folder" goes: the active pane of the split view the window shows, which stays
 * split, or otherwise the folder as the page's one folder.
 */
function folderHref(folder: string): string {
  const split = SplitAddress.here();
  return split && FolderPath.isShownAt(window.location.pathname)
    ? SplitAddress.openInActive(split, folder)
    : fileHref(folder);
}

export const TransferReport = {
  describe,
  folderHref,
  describeAll,
  sections,
  merge,
  skip,
  show,
  undo,
} as const;
