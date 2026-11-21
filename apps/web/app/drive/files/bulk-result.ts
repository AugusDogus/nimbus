/** Outcome of applying one action to several entries. Failures keep the entry name and reason. */
export type BulkResult = {
  succeeded: number;
  failed: { name: string; reason: string }[];
};

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : "The server did not say why.";

/**
 * Call `visit` for every item, a bounded number at a time. The server serializes filesystem
 * commits, so a small window keeps requests batched without queueing thousands of promises.
 */
async function each<T>(
  items: readonly T[],
  visit: (item: T) => Promise<void>,
  concurrency = 16,
) {
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) await visit(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
}

/** Run `operation` for every item (see `each`), counting successes and keeping failures. */
async function run<T extends { name: string }>(
  items: readonly T[],
  operation: (item: T) => Promise<unknown>,
  concurrency = 16,
): Promise<BulkResult> {
  const result: BulkResult = { succeeded: 0, failed: [] };
  await each(
    items,
    async (item) => {
      try {
        await operation(item);
        result.succeeded++;
      } catch (error) {
        result.failed.push({ name: item.name, reason: reasonOf(error) });
      }
    },
    concurrency,
  );
  return result;
}

const count = (n: number) =>
  n === 1 ? "1 item" : `${n.toLocaleString()} items`;

/**
 * A summary for a toast, e.g. "Moved 10 of 12 items to trash. “a.txt”: reason 1 more item also
 * failed." The server's reason says what happened to the item and what to do, so nothing is
 * claimed here about the failed items beyond it.
 */
function describe(result: BulkResult, verb: string, place = "") {
  const total = result.succeeded + result.failed.length;
  const [first, ...rest] = result.failed;
  if (!first)
    return { ok: true, message: `${verb} ${count(total)}${place}` } as const;
  const more = rest.length
    ? ` ${rest.length === 1 ? "1 more item" : `${rest.length.toLocaleString()} more items`} also failed.`
    : "";
  const head = result.succeeded
    ? `${verb} ${result.succeeded.toLocaleString()} of ${count(total)}${place}.`
    : `Nothing was ${verb.toLowerCase()}${place}.`;
  return {
    ok: false,
    message: `${head} “${first.name}”: ${first.reason}${more}`,
  } as const;
}

export const BulkResult = { each, run, reasonOf, describe } as const;
