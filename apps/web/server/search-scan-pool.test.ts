import { afterAll, describe, expect, it } from "bun:test";
import {
  createSearchIndex,
  type SearchRequest,
} from "@nimbus/api/search-index";
import { createScanPool, searchWithPool } from "@nimbus/api/search-scan-pool";

const pool = createScanPool(
  () => new Worker(new URL("./search-scan.worker.ts", import.meta.url)),
  3,
);
afterAll(() => pool.close());

/**
 * A random tree, compacted. With `churn`, some of it is removed since and
 * more is added since, so scans meet dead slots and the delta as well.
 */
function tree(seed: number, churn = false) {
  let state = seed;
  const random = () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const words = ["alpha", "Beta", "report", "2024", "invoice", "café", "notes"];
  const pick = () => words[Math.floor(random() * words.length)] ?? "x";
  const index = createSearchIndex();
  const folders = [""];
  const grow = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      const parent = folders[Math.floor(random() * folders.length)] ?? "";
      const path = `${parent ? `${parent}/` : ""}${pick()}-${pick()} ${i}`;
      if (random() < 0.15) {
        index.add(path, "dir");
        folders.push(path);
      } else index.add(path, "file");
    }
  };
  grow(0, 6000);
  index.compact();
  if (churn) {
    // Whole folders go, then new names arrive, some inside surviving folders.
    for (let removed = 0; removed < 40; removed++) {
      const at = 1 + Math.floor(random() * (folders.length - 1));
      const [gone] = folders.splice(at, 1);
      if (gone === undefined) continue;
      index.remove(gone);
      for (let i = folders.length - 1; i > 0; i--)
        if (folders[i]?.startsWith(`${gone}/`)) folders.splice(i, 1);
    }
    grow(6000, 6600);
  }
  return { index, folders };
}

describe("search scan pool", () => {
  for (const churn of [false, true])
    it(`answers exactly as a scan on this thread, for every layer, scope and page${churn ? ", with names removed and added since compaction" : ""}`, async () => {
      const { index, folders } = tree(5, churn);
      const queries = [
        "a",
        "re",
        "report",
        "2024 invoice",
        "beta/notes",
        "café alpha",
        "zzz",
        "reprot",
        "alpah 2024",
        "rprt",
        "cafe",
        "cafe alpah",
        "alphaBeta",
        "report-notes 2024-03-15",
      ];
      for (const query of queries)
        for (const scope of [
          { type: "all" } as const,
          { type: "grants", paths: folders.slice(3, 9) } as const,
        ])
          for (const depth of ["instant", "full"] as const)
            for (const page of [1, 2]) {
              const first: SearchRequest = {
                query,
                root: "",
                limit: 25,
                scope,
                depth,
                now: 1,
              };
              const request =
                page === 1
                  ? first
                  : { ...first, cursor: index.search(first).next ?? undefined };
              const here = index.search(request);
              const parallel = await searchWithPool(
                () => index,
                request,
                pool,
                0,
              );
              expect({ query, scope, depth, page, ...parallel }).toEqual({
                query,
                scope,
                depth,
                page,
                ...here,
              });
            }
    });

  it("counts no word of a folder removed since compaction, wherever the scan is split", async () => {
    const index = createSearchIndex();
    // Most of the name bytes sit inside the folder that goes, so the scan is
    // split inside it, with the removed folder above a piece.
    for (let i = 0; i < 400; i++) index.add(`aaa/zebra/notes ${i}.txt`, "file");
    index.add("bbb/zebre notes.txt", "file");
    index.compact();
    index.remove("aaa/zebra");
    const request: SearchRequest = {
      query: "zebra notes",
      root: "",
      limit: 25,
      scope: { type: "all" },
      depth: "full",
      now: 1,
    };
    const here = index.search(request);
    // No visible name holds "zebra", so the typo layer reads it as "zebre".
    expect(here.hits.map((hit) => hit.path)).toEqual(["bbb/zebre notes.txt"]);
    expect(await searchWithPool(() => index, request, pool, 0)).toEqual(here);
  });

  it("answers callers through the workers exactly as if names they cannot read were not there", async () => {
    const hidden = [
      "secret/alpah report.txt",
      "secret/reprot 2024.txt",
      "secret/invoices alpha",
      "secret/cafe beta notes",
      "secret/gone/report 2024-03-15.txt",
      "secret/notes-2024-03-15.txt",
    ];
    // Both compact at the same points: how often the layout is rebuilt is
    // the coarse signal search-query.ts documents, not a name.
    const twin = (withHidden: boolean) => {
      const { index, folders } = tree(21, true);
      if (withHidden) for (const path of hidden) index.add(path, "file");
      index.compact();
      for (let i = 0; i < 50; i++)
        index.add(`late/report alpha ${i}.txt`, "file");
      if (withHidden) {
        // Some hidden names removed since, and more added since.
        index.remove("secret/gone");
        index.add("secret/later/alpha invioce.txt", "file");
        // A word only hidden names hold, which a misspelled query would take.
        index.add("secret/later/zephyr notes.txt", "file");
      }
      return { index, folders: [...folders, "late"] };
    };
    const withHidden = twin(true);
    const without = twin(false);
    const scope = {
      type: "grants",
      paths: without.folders.slice(3, 9),
    } as const;
    const pages = async (index: typeof withHidden.index, query: string) => {
      const seen = [];
      let cursor: string | undefined;
      do {
        const page = await searchWithPool(
          () => index,
          { query, root: "", limit: 7, scope, depth: "full", now: 1, cursor },
          pool,
          0,
        );
        if (!page)
          throw new Error("A scan was stopped; none run concurrently.");
        seen.push({ ...page, next: page.next !== null });
        cursor = page.next ?? undefined;
      } while (cursor !== undefined);
      return seen;
    };
    for (const query of [
      "report",
      "reprot",
      "alpah 2024",
      "invioce",
      "cafe beta",
      "2024-03-15",
      "notes alpha",
      "zephir notes",
    ])
      expect({ query, pages: await pages(withHidden.index, query) }).toEqual({
        query,
        pages: await pages(without.index, query),
      });
  });

  it("answers from the current index when it changed during the scan", async () => {
    const { index } = tree(9);
    const request: SearchRequest = {
      query: "report",
      root: "",
      limit: 10_000,
      scope: { type: "all" },
      depth: "full",
      now: 1,
    };
    const pending = searchWithPool(() => index, request, pool, 0);
    index.add("late/report-added-meanwhile.txt", "file");
    const answer = await pending;
    expect(answer?.hits.map((hit) => hit.path)).toContain(
      "late/report-added-meanwhile.txt",
    );
    expect(answer).toEqual(index.search(request));
  });

  it("stops a scan when a newer one starts", async () => {
    const { index } = tree(13);
    const request: SearchRequest = {
      query: "e",
      root: "",
      limit: 10,
      scope: { type: "all" },
      depth: "full",
      now: 1,
    };
    const first = searchWithPool(() => index, request, pool, 0);
    const second = searchWithPool(
      () => index,
      { ...request, query: "notes" },
      pool,
      0,
    );
    expect(await first).toBeNull();
    expect(await second).toEqual(index.search({ ...request, query: "notes" }));
  });

  it("answers only the newest of a burst, with marks no stopped scan disturbed", async () => {
    const { index } = tree(17);
    const queries = ["e", "report 2024", "alpha beta", "notes café", "invoice"];
    const request = (query: string): SearchRequest => ({
      query,
      root: "",
      limit: 30,
      scope: { type: "all" },
      depth: "full",
      now: 1,
    });
    const answers = await Promise.all(
      queries.map((query) =>
        searchWithPool(() => index, request(query), pool, 0),
      ),
    );
    expect(answers.slice(0, -1)).toEqual(queries.slice(0, -1).map(() => null));
    expect(answers.at(-1)).toEqual(index.search(request("invoice")));
    // The next words search starts from clean marks.
    expect(
      await searchWithPool(() => index, request("report 2024"), pool, 0),
    ).toEqual(index.search(request("report 2024")));
  });
});
