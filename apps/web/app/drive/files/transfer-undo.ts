import { trpcClient } from "@/lib/trpc";
import { RunningTransfers } from "./running-transfers";
import { BreadcrumbTrail } from "./breadcrumb-trail";
import { outcomeUnknown, type TransferResult } from "./transfer-result";

type Outcome = Awaited<
  ReturnType<typeof trpcClient.files.undo.mutate>
>["outcomes"][number];

/**
 * What undoing one item did: undone, left as it is with the reason why, or not known, when the
 * answer was lost.
 */
export type UndoItem =
  | { kind: "undone"; name: string }
  | { kind: "kept"; name: string; message: string }
  | { kind: "unconfirmed"; name: string; message: string };

/** Receipts per request; the server accepts at most this many at once. */
const batch = 500;

type Receipt = TransferResult["transferred"][number]["receipt"];

/**
 * Ask the server to undo every transferred item of `result`. The server checks each receipt
 * again and reports per item. A request the server refused reports its items as left alone;
 * any other failure, such as a lost answer, reports them as not known, since it may have been
 * carried out, and is never sent again.
 */
async function run(
  result: TransferResult,
  undo: (receipts: Receipt[]) => Promise<{ outcomes: readonly Outcome[] }> = (
    receipts,
  ) => trpcClient.files.undo.mutate({ receipts }),
  {
    watched = () => false,
    hold = () => () => undefined,
    top = "",
  }: {
    /** Whether something on screen shows the Undo running (see `RunningTransfers`). */
    watched?: () => boolean;
    /** Holds the page while the Undo runs; returns what releases it (see `LeaveGuard`). */
    hold?: () => () => void;
    /** The account's top folder, which messages call by the root's label. */
    top?: string;
  } = {},
): Promise<UndoItem[]> {
  const release = hold();
  const finish = RunningTransfers.start({
    verb: "Undoing",
    items: result.transferred.map((item) => item.source),
    destination: null,
    watched,
  });
  try {
    return await undoAll(result, undo, top);
  } finally {
    finish();
    release();
  }
}

async function undoAll(
  result: TransferResult,
  undo: (receipts: Receipt[]) => Promise<{ outcomes: readonly Outcome[] }>,
  top: string,
): Promise<UndoItem[]> {
  const items: UndoItem[] = [];
  for (let start = 0; start < result.transferred.length; start += batch) {
    const slice = result.transferred.slice(start, start + batch);
    try {
      const { outcomes } = await undo(slice.map((item) => item.receipt));
      outcomes.forEach((outcome, index) => {
        const name = slice[index]?.source.name ?? "";
        items.push(
          outcome.kind === "undone"
            ? { kind: "undone", name }
            : outcome.kind === "kept"
              ? { kind: "kept", name, message: outcome.message }
              : { kind: "unconfirmed", name, message: outcome.message },
        );
      });
    } catch (error) {
      for (const item of slice) {
        const name = item.source.name;
        items.push(
          outcomeUnknown(error)
            ? {
                kind: "unconfirmed",
                name,
                message: `Nimbus could not confirm whether “${name}” was put back. Check ${BreadcrumbTrail.name(parentOf(item.receipt.from), top)} and ${BreadcrumbTrail.name(parentOf(item.receipt.to), top)}.`,
              }
            : {
                kind: "kept",
                name,
                message: `Nothing was undone for “${name}”, because the request failed: ${error instanceof Error ? error.message : "The server did not say why."}`,
              },
        );
      }
    }
  }
  return items;
}

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * A summary for a toast: "Moved 3 items back to Projects.", "Moved the copy “a (1).txt” to
 * trash.", or "Moved 2 of 3 items back. “b.txt” was changed since and stayed in “Archive”."
 */
function describe(
  result: TransferResult,
  items: readonly UndoItem[],
  /** The account's top folder, which the message calls by the root's label. */
  top = "",
) {
  const undone = items.filter((item) => item.kind === "undone").length;
  // Items left as they are, and items Nimbus could not learn about, each with its message.
  const kept = items.flatMap((item) => (item.kind === "undone" ? [] : [item]));
  const unsure = kept.some((item) => item.kind === "unconfirmed");
  const total = items.length;
  const copies = result.operation === "copy";
  const [first, ...rest] = kept;
  if (!first) {
    const [only] = result.transferred;
    if (copies)
      return {
        ok: true,
        message:
          total === 1 && only
            ? `Moved the copy “${only.name}” to trash.`
            : `Moved the ${total.toLocaleString()} copies to trash.`,
      } as const;
    const origins = new Set(
      result.transferred.map((item) => parentOf(item.receipt.from)),
    );
    const [origin] = origins;
    const where =
      origins.size === 1 && origin !== undefined
        ? ` to ${BreadcrumbTrail.name(origin, top)}`
        : " where they were";
    return {
      ok: true,
      message:
        total === 1 && only
          ? `Moved “${only.source.name}” back${where}.`
          : `Moved ${total.toLocaleString()} items back${where}.`,
    } as const;
  }
  // Nothing is said to have stayed while some items may have been put back.
  const head = undone
    ? copies
      ? `Moved ${undone.toLocaleString()} of ${total.toLocaleString()} copies to trash.`
      : `Moved ${undone.toLocaleString()} of ${total.toLocaleString()} items back.`
    : unsure
      ? ""
      : "Nothing was undone.";
  const more = !rest.length
    ? ""
    : rest.some((item) => item.kind === "unconfirmed")
      ? ` ${rest.length === 1 ? "1 more item was" : `${rest.length.toLocaleString()} more items were`} left as ${rest.length === 1 ? "it is" : "they are"} or could not be confirmed; see Details.`
      : ` ${rest.length === 1 ? "1 more item was" : `${rest.length.toLocaleString()} more items were`} left as ${rest.length === 1 ? "it is" : "they are"}.`;
  return {
    ok: false,
    message: `${head ? `${head} ` : ""}${first.message}${more}`,
  } as const;
}

export const TransferUndo = { run, describe } as const;
