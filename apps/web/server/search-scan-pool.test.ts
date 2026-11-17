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

function tree(seed: number) {
  let state = seed;
  const random = () =>
    (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const words = ["alpha", "Beta", "report", "2024", "invoice", "café", "notes"];
  const pick = () => words[Math.floor(random() * words.length)] ?? "x";
  const index = createSearchIndex();
  const folders = [""];
  for (let i = 0; i < 6000; i++) {
    const parent = folders[Math.floor(random() * folders.length)] ?? "";
    const path = `${parent ? `${parent}/` : ""}${pick()}-${pick()} ${i}`;
    if (random() < 0.15) {
      index.add(path, "dir");
      folders.push(path);
    } else index.add(path, "file");
  }
  index.compact();
  return { index, folders };
}

describe("search scan pool", () => {
  it("answers exactly as a scan on this thread, for every layer, scope and page", async () => {
    const { index, folders } = tree(5);
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
