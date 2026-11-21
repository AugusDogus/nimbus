import { trpcClient } from "@/lib/trpc";
import { DriveRoot } from "@nimbus/api/drive-root";
import { BreadcrumbTrail } from "./breadcrumb-trail";
import type { TransferResult } from "./transfer-result";

type Outcome = Awaited<
  ReturnType<typeof trpcClient.files.undo.mutate>
>["outcomes"][number];

/** What undoing one item did: undone, or left as it is with the reason why. */
export type UndoItem =
  | { kind: "undone"; name: string }
  | { kind: "kept"; name: string; message: string };

/** Receipts per request; the server accepts at most this many at once. */
const batch = 500;

/**
 * Ask the server to undo every transferred item of `result`. The server checks each receipt
 * again and reports per item; a request that fails reports its items as left alone.
 */
async function run(
  result: TransferResult,
  undo: (
    receipts: TransferResult["transferred"][number]["receipt"][],
  ) => Promise<{ outcomes: Outcome[] }> = (receipts) =>
    trpcClient.files.undo.mutate({ receipts }),
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
            : { kind: "kept", name, message: outcome.message },
        );
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "The server did not answer.";
      for (const item of slice)
        items.push({
          kind: "kept",
          name: item.source.name,
          message: `Nothing was undone for “${item.source.name}”, because the request failed: ${reason}`,
        });
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
  const kept = items.flatMap((item) => (item.kind === "kept" ? [item] : []));
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
        ? ` to ${BreadcrumbTrail.nameOf(origin, top, DriveRoot.label)}`
        : " where they were";
    return {
      ok: true,
      message:
        total === 1 && only
          ? `Moved “${only.source.name}” back${where}.`
          : `Moved ${total.toLocaleString()} items back${where}.`,
    } as const;
  }
  const head = undone
    ? copies
      ? `Moved ${undone.toLocaleString()} of ${total.toLocaleString()} copies to trash.`
      : `Moved ${undone.toLocaleString()} of ${total.toLocaleString()} items back.`
    : "Nothing was undone.";
  const more = rest.length
    ? ` ${rest.length === 1 ? "1 more item was" : `${rest.length.toLocaleString()} more items were`} left as ${rest.length === 1 ? "it is" : "they are"}.`
    : "";
  return { ok: false, message: `${head} ${first.message}${more}` } as const;
}

export const TransferUndo = { run, describe } as const;
