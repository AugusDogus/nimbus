import { describe, expect, it } from "bun:test";
import { createSearchIndex, type SearchScope } from "./search-index";
import {
  SearchStopped,
  type HistoryEntry,
  type SearchRequest,
  type SearchResult,
} from "./search-query";

const all: SearchScope = { type: "all" };

function drive() {
  const index = createSearchIndex(4);
  for (const path of [
    "Finance/2024/invoice-0042.pdf",
    "Finance/2024/receipt-ikea.pdf",
    "Finance/2023/invoice-0007.pdf",
    "Finance/2024 invoice summary.xlsx",
    "Documents/annual 2026 report.pdf",
    "Documents/annual report.pdf",
    "Documents/report.pdf",
    "Projects/robot/robot-arm-notes.md",
    "Projects/website/notes.txt",
    "Projects/website/meeting-notes.txt",
  ])
    index.add(path, "file");
  return index;
}

const full = (
  index: ReturnType<typeof createSearchIndex>,
  query: string,
  extra: Partial<SearchRequest> = {},
) =>
  index
    .search({ query, root: "", limit: 50, scope: all, depth: "full", ...extra })
    .hits.map((hit) => hit.path);

describe("words layer", () => {
  for (const compacted of [false, true])
    describe(compacted ? "compacted" : "before compaction", () => {
      const index = drive();
      if (compacted) index.compact();

      it("matches words across the name and the folders above it", () => {
        expect(full(index, "2024 invoice")).toEqual([
          "Finance/2024 invoice summary.xlsx",
          "Finance/2024/invoice-0042.pdf",
        ]);
        expect(full(index, "finance/2024 receipt")).toEqual([
          "Finance/2024/receipt-ikea.pdf",
        ]);
      });

      it("ranks the whole query in a name first, then all words in the name", () => {
        expect(full(index, "annual report")).toEqual([
          "Documents/annual report.pdf",
          "Documents/annual 2026 report.pdf",
        ]);
        expect(full(index, "report annual")).toEqual([
          "Documents/annual report.pdf",
          "Documents/annual 2026 report.pdf",
        ]);
      });

      it("needs a word in the name, not only in folders", () => {
        // Nothing inside Projects/robot is named "projects" or "robot" except the notes.
        expect(full(index, "projects robot")).toEqual([
          "Projects/robot",
          "Projects/robot/robot-arm-notes.md",
        ]);
      });

      it("keeps the instant layer's single-word results and order", () => {
        expect(full(index, "notes")).toEqual(
          index
            .search({ query: "notes", root: "", limit: 50, scope: all })
            .hits.map((hit) => hit.path),
        );
      });

      it("labels which layer found each hit", () => {
        expect(
          index
            .search({
              query: "2024 invoice",
              root: "",
              limit: 50,
              scope: all,
              depth: "full",
            })
            .hits.map((hit) => hit.match),
        ).toEqual(["name", "words"]);
      });

      it("matches folders above a grant, but never returns what is outside it", () => {
        const grants: SearchScope = { type: "grants", paths: ["Finance/2024"] };
        expect(full(index, "finance invoice", { scope: grants })).toEqual([
          "Finance/2024/invoice-0042.pdf",
        ]);
        expect(full(index, "2023 invoice", { scope: grants })).toEqual([]);
      });

      it("keeps the search root's own folders as context", () => {
        expect(full(index, "website notes", { root: "Projects" })).toEqual([
          "Projects/website/notes.txt",
          "Projects/website/meeting-notes.txt",
        ]);
      });
    });
});

describe("ranking by the caller's history", () => {
  const now = Date.now();
  const opened = (path: string): HistoryEntry => ({
    path,
    openedAt: now,
    visits: 20,
    starred: true,
  });

  it("puts recent opens first within a layer, never above a better match", () => {
    for (const compacted of [false, true]) {
      const index = drive();
      if (compacted) index.compact();
      const history = [opened("Projects/website/meeting-notes.txt")];
      expect(full(index, "notes", { history })).toEqual([
        "Projects/website/notes.txt",
        "Projects/website/meeting-notes.txt",
        "Projects/robot/robot-arm-notes.md",
      ]);
      expect(full(index, "notes.txt", { history })).toEqual([
        "Projects/website/notes.txt",
        "Projects/website/meeting-notes.txt",
      ]);
    }
  });
});

describe("paging", () => {
  it("returns every match once across pages, in the first page's order", () => {
    const index = createSearchIndex();
    for (let folder = 0; folder < 20; folder++)
      for (let file = 0; file < 30; file++)
        index.add(`f${folder}/report-${file}.txt`, "file");
    index.add("f3/2024", "dir");
    index.add("f3/2024/report.txt", "file");
    index.compact();
    for (let i = 0; i < 40; i++) index.add(`late/report late ${i}.txt`, "file");

    const request: SearchRequest = {
      query: "report",
      root: "",
      limit: 7,
      scope: all,
      depth: "full",
    };
    const first = index.search(request);
    expect(first.total).toBe(641);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = index.search({ ...request, cursor });
      seen.push(...page.hits.map((hit) => hit.path));
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(641);
    expect(new Set(seen).size).toBe(641);
    expect(seen.slice(0, 7)).toEqual(first.hits.map((hit) => hit.path));
    expect(
      index.search({ ...request, limit: 1000 }).hits.map((hit) => hit.path),
    ).toEqual(seen);
  });

  it("continues after the last result shown while the index changes between pages", () => {
    const index = createSearchIndex();
    for (let file = 0; file < 10; file++) index.add(`a/note-${file}`, "file");
    index.compact();
    const request: SearchRequest = {
      query: "note",
      root: "",
      limit: 3,
      scope: all,
      depth: "full",
    };
    const first = index.search(request);
    const shown = first.hits.map((hit) => hit.path);
    const order = index
      .search({ ...request, limit: 100 })
      .hits.map((hit) => hit.path);
    // One not yet shown disappears, one already shown disappears, and a new one arrives.
    const gone = order[5] ?? "";
    index.remove(gone);
    index.remove(shown[0] ?? "");
    index.add("b/note-late", "file");
    const rest: string[] = [];
    for (let cursor = first.next ?? undefined; cursor !== undefined;) {
      const page = index.search({ ...request, cursor });
      rest.push(...page.hits.map((hit) => hit.path));
      cursor = page.next ?? undefined;
    }
    const expected = order.slice(3).filter((path) => path !== gone);
    expect(rest).toEqual([...expected, "b/note-late"]);
  });

  /** Every page of `request`, with `between` run before each later page. */
  function pages(
    index: ReturnType<typeof createSearchIndex>,
    request: SearchRequest,
    between: (page: number) => void,
  ) {
    const all: string[][] = [];
    let restarted = 0;
    let cursor: string | undefined;
    do {
      if (all.length) between(all.length);
      const page = index.search({ ...request, cursor });
      if (page.restarted) restarted++;
      all.push(page.hits.map((hit) => hit.path));
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    return { all, restarted };
  }

  it("continues after a compaction with every result exactly once", () => {
    for (const seed of [1, 2, 3]) {
      const index = createSearchIndex();
      for (let folder = 0; folder < 6; folder++)
        for (let file = 0; file < 5; file++)
          index.add(`f${folder}/note-${file}.txt`, "file");
      index.compact();
      // Added since compaction, so they rank after their equals until the
      // next compaction places them among them in tree order.
      for (let folder = 0; folder < 6; folder += seed)
        index.add(`f${folder}/note-${5 + seed}.txt`, "file");
      const request: SearchRequest = {
        query: "note",
        root: "",
        limit: 7,
        scope: all,
        depth: "full",
        now: 1,
      };
      const expected = index
        .search({ ...request, limit: 1000 })
        .hits.map((hit) => hit.path)
        .sort();
      // A page continued across one compaction stays in the order the
      // session started in; a second compaction would restart it.
      const { all: seen, restarted } = pages(index, request, (page) => {
        if (page === seed) index.compact();
      });
      expect(restarted).toBe(0);
      const flat = seen.flat();
      expect({ seed, repeats: flat.length - new Set(flat).size }).toEqual({
        seed,
        repeats: 0,
      });
      expect([...flat].sort()).toEqual(expected);
    }
  });

  it("never repeats a result when a compaction reorders entries added since the last one", () => {
    for (const limit of [1, 2, 3])
      for (const compactAfter of [1, 2, 3]) {
        const index = createSearchIndex();
        for (const folder of ["a", "b", "c"])
          index.add(`${folder}/note-0`, "file");
        index.compact();
        // Ranked after every compacted equal until a compaction places them
        // in tree order among them.
        for (const folder of ["c", "b", "a"])
          for (const file of [1, 2])
            index.add(`${folder}/note-${file}`, "file");
        const request: SearchRequest = {
          query: "note",
          root: "",
          limit,
          scope: all,
          depth: "full",
          now: 1,
        };
        const { all: seen, restarted } = pages(index, request, (page) => {
          if (page === compactAfter) index.compact();
        });
        const flat = seen.flat();
        expect({ limit, compactAfter, restarted, flat }).toEqual({
          limit,
          compactAfter,
          restarted: 0,
          flat: [...new Set(flat)],
        });
        expect(flat).toHaveLength(9);
      }
  });

  it("pages through accent, date and joined-word readings across a compaction", () => {
    const index = createSearchIndex();
    for (let folder = 0; folder < 4; folder++)
      for (let file = 0; file < 4; file++) {
        index.add(`f${folder}/scan 2024-03-15 ${file}.pdf`, "file");
        index.add(`f${folder}/Scan_15.03.2024_${file}.pdf`, "file");
      }
    index.compact();
    for (let folder = 0; folder < 4; folder++)
      index.add(`f${folder}/scän 20240315 late.pdf`, "file");
    const request: SearchRequest = {
      query: "scan 15-03-2024",
      root: "",
      limit: 5,
      scope: all,
      depth: "full",
      now: 1,
    };
    const expected = index
      .search({ ...request, limit: 1000 })
      .hits.map((hit) => hit.path)
      .sort();
    expect(expected).toHaveLength(36);
    const { all: seen, restarted } = pages(index, request, (page) => {
      if (page === 2) index.compact();
    });
    expect(restarted).toBe(0);
    const flat = seen.flat();
    expect(flat.length).toBe(new Set(flat).size);
    expect([...flat].sort()).toEqual(expected);
  });

  it("starts again rather than skip when the layout is two compactions old", () => {
    const index = createSearchIndex();
    for (let file = 0; file < 10; file++) index.add(`a/note-${file}`, "file");
    index.compact();
    for (let file = 0; file < 4; file++) index.add(`b/note-${file}`, "file");
    const request: SearchRequest = {
      query: "note",
      root: "",
      limit: 4,
      scope: all,
      depth: "full",
      now: 1,
    };
    // A restarted page is the first page again, so the layout moves on twice
    // before the second page only, or across the second and third; paging
    // on from there must skip nothing.
    for (const spread of [false, true]) {
      const { all: seen, restarted } = pages(index, request, (page) => {
        if (page === 1) index.compact();
        if (page === (spread ? 2 : 1)) index.compact();
      });
      expect({ spread, restarted }).toEqual({ spread, restarted: 1 });
      expect([...new Set(seen.flat())].sort()).toEqual(
        index
          .search({ ...request, limit: 1000 })
          .hits.map((hit) => hit.path)
          .sort(),
      );
    }
  });

  it("starts again rather than skip when the caller's history changed", () => {
    const index = createSearchIndex();
    for (let file = 0; file < 10; file++) index.add(`a/note-${file}`, "file");
    index.compact();
    const request: SearchRequest = {
      query: "note",
      root: "",
      limit: 4,
      scope: all,
      depth: "full",
      now: 1,
    };
    const first = index.search(request);
    // An unseen result was opened meanwhile, which would now rank first.
    const opened: HistoryEntry = {
      path: "a/note-9",
      openedAt: 1,
      visits: 30,
      starred: true,
    };
    const second = index.search({
      ...request,
      history: [opened],
      cursor: first.next ?? undefined,
    });
    expect(second.restarted).toBe(true);
    expect(second.hits.map((hit) => hit.path)).toContain("a/note-9");
  });

  it("restarts with the first page only, however deep the cursor was", () => {
    const index = createSearchIndex();
    for (let file = 0; file < 100; file++) index.add(`a/note-${file}`, "file");
    index.compact();
    const request: SearchRequest = {
      query: "note",
      root: "",
      limit: 4,
      scope: all,
      depth: "full",
      now: 1,
    };
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++)
      cursor = index.search({ ...request, cursor }).next ?? undefined;
    // An open since the last page ranks differently, so the cursor cannot continue.
    const history: HistoryEntry[] = [
      { path: "a/note-50", openedAt: 1, visits: 3, starred: false },
    ];
    const restarted = index.search({ ...request, history, cursor });
    const fresh = index.search({ ...request, history, limit: 8 });
    expect(restarted.restarted).toBe(true);
    expect(restarted.total).toBe(100);
    expect(restarted.hits).toEqual(fresh.hits.slice(0, 4));
    const after = index.search({
      ...request,
      history,
      cursor: restarted.next ?? undefined,
    });
    expect(after.restarted).toBe(false);
    expect(after.hits).toEqual(fresh.hits.slice(4, 8));
  });

  it("keeps the typo layer a paging session started with when a literal match arrives", () => {
    const index = createSearchIndex();
    for (let file = 1; file <= 3; file++)
      index.add(`docs/invoice-${file}.pdf`, "file");
    index.compact();
    const request: SearchRequest = {
      query: "invioce",
      root: "",
      limit: 1,
      scope: all,
      depth: "full",
      now: 1,
    };
    const first = index.search(request);
    expect(first.hits.map((hit) => hit.path)).toEqual(["docs/invoice-1.pdf"]);
    // The word typed now matches a name as typed, which alone would turn the
    // typo layer off for a new search.
    index.add("docs/invioce-new.pdf", "file");
    const rest: string[] = [];
    for (let cursor = first.next ?? undefined; cursor !== undefined;) {
      const page = index.search({ ...request, cursor });
      expect(page.restarted).toBe(false);
      rest.push(...page.hits.map((hit) => hit.path));
      cursor = page.next ?? undefined;
    }
    expect(rest).toEqual(["docs/invoice-2.pdf", "docs/invoice-3.pdf"]);
  });

  it("restarts rather than skip when the corrections tried change between pages", () => {
    const index = createSearchIndex();
    for (let file = 1; file <= 3; file++)
      index.add(`docs/invoice-${file}.pdf`, "file");
    index.compact();
    const request: SearchRequest = {
      query: "invioce",
      root: "",
      limit: 1,
      scope: all,
      depth: "full",
      now: 1,
    };
    const first = index.search(request);
    // Many names now hold a closer reading, which a new search would try first.
    for (let file = 0; file < 40; file++)
      index.add(`docs/invoices ${file}.pdf`, "file");
    for (let file = 0; file < 40; file++)
      index.add(`docs/invoce ${file}.pdf`, "file");
    const second = index.search({
      ...request,
      cursor: first.next ?? undefined,
    });
    const fresh = index.search(request);
    if (fresh.terms.join() === first.terms.join())
      throw new Error(
        "The corrections did not change; the test proves nothing.",
      );
    expect(second.restarted).toBe(true);
    expect(second.hits).toEqual(fresh.hits);
  });

  it("restarts a cursor passed with another query, root, depth or scope", () => {
    const index = createSearchIndex();
    for (let file = 0; file < 20; file++) {
      index.add(`a/note-${file}`, "file");
      index.add(`a/memo-${file}`, "file");
    }
    index.compact();
    const request: SearchRequest = {
      query: "note",
      root: "",
      limit: 5,
      scope: all,
      depth: "full",
      now: 1,
    };
    const cursor = index.search(request).next ?? undefined;
    for (const other of [
      { query: "memo" },
      { root: "a" },
      { depth: "instant" },
      { scope: { type: "grants", paths: ["a"] } },
    ] as const) {
      const fresh = { ...request, ...other };
      const page = index.search({ ...fresh, cursor });
      expect({ other, restarted: page.restarted }).toEqual({
        other,
        restarted: true,
      });
      expect(page.hits).toEqual(index.search(fresh).hits);
    }
  });

  it("restarts a cursor from before the index was built again", () => {
    // Two runs of the search worker, as two processes: the same code loaded
    // afresh each time, building the same layouts in the same order. The
    // second gets the cursor of the first and says whether its page restarted.
    const run = (cursor: string) => {
      const script = `
        import { createSearchIndex } from ${JSON.stringify(`${import.meta.dir}/search-index.ts`)};
        const index = createSearchIndex();
        for (let file = 0; file < 20; file++) index.add("a/note-" + file, "file");
        index.compact();
        const page = index.search({ query: "note", root: "", limit: 5, scope: { type: "all" }, depth: "full", now: 1, cursor: process.argv[1] || undefined });
        console.log(JSON.stringify({ next: page.next, restarted: page.restarted }));
      `;
      const done = Bun.spawnSync(["bun", "-e", script, cursor]);
      const printed: unknown = JSON.parse(done.stdout.toString());
      if (
        typeof printed !== "object" ||
        printed === null ||
        !("next" in printed) ||
        !("restarted" in printed)
      )
        throw new Error(`Unexpected output: ${done.stderr.toString()}`);
      return { next: printed.next, restarted: printed.restarted };
    };
    const first = run("");
    expect(typeof first.next).toBe("string");
    expect(run(String(first.next)).restarted).toBe(true);
  });

  it("starts over for a cursor no page returned", () => {
    const index = drive();
    const page = index.search({
      query: "notes",
      root: "",
      limit: 50,
      scope: all,
      cursor: "not-a-cursor",
    });
    expect(page.hits).toHaveLength(3);
    expect(page.restarted).toBe(true);
  });
});

describe("words layer against a brute-force oracle", () => {
  it("agrees through random adds, removes, compactions, roots and grants", () => {
    let seed = 11;
    const random = () =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(random() * items.length)];
    const parts = [
      "alpha",
      "Beta",
      "gamma ray",
      "delta",
      "2024",
      "épsilon",
      "zeta.txt",
      // One typo from a word the queries use, so a typo layer that ran when
      // it should not would find it.
      "delte",
    ];
    const index = createSearchIndex(2);
    const oracle = new Map<string, "file" | "dir">();
    const within = (parent: string, child: string) =>
      parent === "" || child === parent || child.startsWith(`${parent}/`);
    const fold = (text: string) => text.normalize("NFC").toLowerCase();
    for (let step = 0; step < 2500; step++) {
      const dirs = [
        "",
        ...[...oracle]
          .filter(([, kind]) => kind === "dir")
          .map(([path]) => path),
      ];
      const action = random();
      if (action < 0.6) {
        const base = pick(dirs) ?? "";
        const path = `${base ? `${base}/` : ""}${pick(parts)}${Math.floor(random() * 3)}`;
        const kind = random() < 0.4 ? "dir" : "file";
        for (const existing of [...oracle.keys()])
          if (within(path, existing) && oracle.get(path) !== kind)
            oracle.delete(existing);
        oracle.set(path, kind);
        index.add(path, kind);
      } else if (action < 0.72 && oracle.size) {
        const path = pick([...oracle.keys()]) ?? "";
        for (const existing of [...oracle.keys()])
          if (within(path, existing)) oracle.delete(existing);
        index.remove(path);
      } else if (action < 0.78) index.compact();
      if (step % 10 !== 0) continue;
      const query =
        pick([
          "alpha beta",
          "2024 ray",
          "gamma/delta",
          "a 2024",
          "zeta épsilon",
          "beta1 alpha0",
          "eta",
          "delta",
        ]) ?? "";
      const root = pick(dirs) ?? "";
      const grants =
        random() < 0.5 ? null : [pick(dirs) ?? "", pick(dirs) ?? ""];
      const needle = fold(query);
      const terms = needle.split(/[\s/]+/).filter(Boolean);
      const holds = (name: string, term: string) =>
        term.length === 1 ? name.startsWith(term) : name.includes(term);
      const expected = [...oracle.keys()]
        .filter((path) => {
          if (path === root || !within(root, path)) return false;
          if (grants !== null && !grants.some((grant) => within(grant, path)))
            return false;
          const segments = path.split("/").map(fold);
          const name = segments[segments.length - 1] ?? "";
          if (name.includes(needle)) return true;
          if (terms.length < 2) return false;
          return (
            terms.some((term) => holds(name, term)) &&
            terms.every((term) =>
              segments.some((segment) => holds(segment, term)),
            )
          );
        })
        .sort();
      const scope: SearchScope =
        grants === null ? { type: "all" } : { type: "grants", paths: grants };
      const instant = index
        .search({ query, root, limit: 10_000, scope })
        .hits.map((hit) => hit.path);
      const answer = index.search({
        query,
        root,
        limit: 10_000,
        scope,
        depth: "full",
      });
      // Typo matches (the fuzzy layer) come after, and only for a word no
      // name the caller may see holds: in its name for a one-word query, and
      // anywhere in its path otherwise.
      const strict = answer.hits.filter((hit) => hit.match !== "fuzzy");
      const fuzzy = answer.hits.filter((hit) => hit.match === "fuzzy");
      const found = strict.map((hit) => hit.path);
      expect({ query, root, grants, found: [...found].sort() }).toEqual({
        query,
        root,
        grants,
        found: expected,
      });
      expect(answer.hits.slice(0, strict.length)).toEqual(strict);
      const visible = [...oracle.keys()].filter(
        (path) =>
          path !== root &&
          within(root, path) &&
          (grants === null || grants.some((grant) => within(grant, path))),
      );
      const held =
        terms.length < 2
          ? expected.length > 0
          : terms.every((term) =>
              visible.some((path) =>
                path
                  .split("/")
                  .map(fold)
                  .some((segment) => holds(segment, term)),
              ),
            );
      if (held)
        expect({ query, root, grants, fuzzy }).toEqual({
          query,
          root,
          grants,
          fuzzy: [],
        });
      for (const hit of fuzzy) {
        expect(expected).not.toContain(hit.path);
        expect(within(root, hit.path) && hit.path !== root).toBe(true);
        if (grants !== null)
          expect(grants.some((grant) => within(grant, hit.path))).toBe(true);
      }
      expect(answer.total).toBe(answer.hits.length);
      // Refining in place never reorders the instant results.
      expect(found.slice(0, instant.length)).toEqual(instant);
    }
  });
});

describe("fuzzy layer", () => {
  it("bounds correction work by the query alone, however long the names", () => {
    // Long names sharing a long stem, none of them visible to the caller:
    // longer than any word corrected, and as long as the longest.
    for (const stem of [
      "abcdefghij".repeat(19),
      "abcdefghij".repeat(3) + "abcdef",
    ]) {
      const index = createSearchIndex();
      for (let name = 0; name < 3000; name++)
        index.add(
          `hidden/${stem}${name.toString(36).padStart(4, "q")}`,
          "file",
        );
      index.add("mine/notes.txt", "file");
      index.compact();
      const started = performance.now();
      const answer = index.search({
        query: `${stem}zzzq`,
        root: "",
        limit: 50,
        scope: { type: "grants", paths: ["mine"] },
        depth: "full",
      });
      expect(answer.hits).toEqual([]);
      // Seconds before the bound; a few milliseconds with it.
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("stops a search whose deadline has passed", () => {
    const index = drive();
    index.compact();
    expect(() =>
      index.search({
        query: "invioce report",
        root: "",
        limit: 50,
        scope: all,
        depth: "full",
        deadline: Date.now() - 1,
      }),
    ).toThrow(SearchStopped);
  });

  const hits = (
    index: ReturnType<typeof createSearchIndex>,
    query: string,
    extra: Partial<SearchRequest> = {},
  ) =>
    index
      .search({
        query,
        root: "",
        limit: 50,
        scope: all,
        depth: "full",
        ...extra,
      })
      .hits.map((hit) => `${hit.match} ${hit.path}`);

  for (const compacted of [false, true])
    describe(compacted ? "compacted" : "before compaction", () => {
      const index = drive();
      index.add("Projects/robot/useConfigTable.ts", "file");
      if (compacted) index.compact();

      it("finds words one typo away, below every stricter match", () => {
        expect(hits(index, "invioce")).toEqual([
          "fuzzy Finance/2024/invoice-0042.pdf",
          "fuzzy Finance/2023/invoice-0007.pdf",
          "fuzzy Finance/2024 invoice summary.xlsx",
        ]);
        expect(hits(index, "invioce 2023")).toEqual([
          "fuzzy Finance/2023/invoice-0007.pdf",
        ]);
      });

      it("finds abbreviations, and words inside camel case names", () => {
        expect(hits(index, "prjcts")).toEqual(["fuzzy Projects"]);
        expect(hits(index, "cnfig")).toEqual([
          "fuzzy Projects/robot/useConfigTable.ts",
        ]);
      });

      it("never runs while typing", () => {
        expect(
          index.search({ query: "invioce", root: "", limit: 50, scope: all })
            .hits,
        ).toEqual([]);
      });

      it("never reaches outside the caller's grants", () => {
        expect(
          hits(index, "invioce", {
            scope: { type: "grants", paths: ["Finance/2023"] },
          }),
        ).toEqual(["fuzzy Finance/2023/invoice-0007.pdf"]);
        expect(
          hits(index, "invioce", {
            scope: { type: "grants", paths: ["Projects"] },
          }),
        ).toEqual([]);
      });
    });

  it("stays out of the way while any name the caller may see holds the word", () => {
    const index = createSearchIndex();
    for (let i = 0; i < 10; i++) index.add(`notes/note-${i}.txt`, "file");
    index.add("other/nots.txt", "file");
    index.compact();
    expect(hits(index, "note")).toHaveLength(11);
    expect(
      hits(index, "note").filter((hit) => hit.startsWith("fuzzy")),
    ).toEqual([]);
    // However few: one name holding it is enough.
    expect(
      hits(index, "note", {
        scope: { type: "grants", paths: ["notes/note-3.txt", "other"] },
      }),
    ).toEqual(["name notes/note-3.txt"]);
    index.remove("notes/note-9.txt");
    // Read apart (note, txt) it finds the notes; it is no typo to correct.
    expect(
      hits(index, "note.txt").filter((hit) => hit.startsWith("fuzzy")),
    ).toEqual([]);
    // A word some name holds is not a typo, however few names hold it.
    expect(hits(index, "nots")).toEqual(["name other/nots.txt"]);
  });
});

describe("what a caller sees never depends on names it may not read", () => {
  const hiddenNames = [
    "secret/zephyrine plan.txt",
    "secret/zephyrines.txt",
    "secret/zephyrinea.txt",
    "secret/zephyrinne draft.txt",
    "secret/zephyrinee.txt",
    "secret/codename/budget.xlsx",
    // Names that would match through accents, dates and joined words.
    "secret/Crème secrète 2024-03-15.txt",
    "secret/crémeux.txt",
    "secret/backup_photos_vault.txt",
    "secret/Zürich 15.03.2024 plan.txt",
    "secret/Brûlé/notes 2024_03.txt",
  ];
  const visibleNames = [
    "team/zephyrina notes.txt",
    "team/zephyrina/agenda.md",
    "team/budget 2026.xlsx",
    "team/notes.txt",
    "team/creme notes 20240315.md",
    "team/backupPhotos.sh",
    "team/zurich.txt",
  ];
  type State = "before compaction" | "compacted" | "mixed, with removals";
  /**
   * The same visible tree, with or without the hidden names. Mixed: half of
   * each compacted, the rest added since, and some of both removed since,
   * hidden ones included, so dead slots and the delta both take part.
   */
  function drive(withHidden: boolean, state: State) {
    const index = createSearchIndex();
    const add = (paths: readonly string[]) => {
      for (const path of paths) index.add(path, "file");
    };
    const hidden = withHidden ? hiddenNames : [];
    if (state !== "mixed, with removals") {
      add([...hidden, ...visibleNames]);
      if (state === "compacted") index.compact();
      return index;
    }
    const half = (paths: readonly string[], first: boolean) =>
      paths.filter((_, at) => at % 2 === (first ? 0 : 1));
    add([...half(hidden, true), ...half(visibleNames, true)]);
    add(withHidden ? ["secret/gone/zephyrine old.txt"] : []);
    add(["team/zephyrina gone.txt", "team/old/notes 2024-03-15.txt"]);
    index.compact();
    add([...half(hidden, false), ...half(visibleNames, false)]);
    if (withHidden) index.remove("secret/gone");
    index.remove("team/zephyrina gone.txt");
    index.remove("team/old");
    return index;
  }
  const teamOnly: SearchScope = { type: "grants", paths: ["team"] };
  /** Everything a caller observes of a page, except the opaque cursor's contents. */
  const seen = (answer: SearchResult) => ({
    hits: answer.hits,
    total: answer.total,
    truncated: answer.truncated,
    more: answer.next !== null,
    restarted: answer.restarted,
    terms: answer.terms,
  });
  const request = (query: string, scope: SearchScope): SearchRequest => ({
    query,
    root: "",
    limit: 2,
    scope,
    depth: "full",
    now: 1,
  });
  /** What a caller observes of the first page. */
  const observed = (
    index: ReturnType<typeof createSearchIndex>,
    query: string,
    scope: SearchScope,
  ) => seen(index.search(request(query, scope)));
  /** What a caller observes of every page, following each page's cursor. */
  const observedPages = (
    index: ReturnType<typeof createSearchIndex>,
    query: string,
    scope: SearchScope,
  ) => {
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = index.search({ ...request(query, scope), cursor });
      pages.push(seen(page));
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    return pages;
  };

  const namedHits = (
    index: ReturnType<typeof createSearchIndex>,
    query: string,
    scope: SearchScope,
  ) =>
    index
      .search({ query, root: "", limit: 50, scope, depth: "full", now: 1 })
      .hits.map((hit) => `${hit.match} ${hit.path}`);

  for (const state of [
    "before compaction",
    "compacted",
    "mixed, with removals",
  ] as const)
    it(`for exact and misspelled words, on every page, ${state}`, () => {
      const withHidden = drive(true, state);
      const without = drive(false, state);
      for (const query of [
        "zephyrine",
        "zephyrinne",
        "zephyrine notes",
        "zephyrnie agenda",
        "codename budget",
        "budgte",
        "notes",
        "crème",
        "creme",
        "cremeux",
        "brule",
        "zürich",
        "2024-03-15",
        "15-03-2024",
        "2024-03",
        "march 2024",
        "backupPhotos",
        "backup_photos",
        "photos-vault",
        "secrète",
        "creme secrete",
      ]) {
        expect({
          query,
          pages: observedPages(withHidden, query, teamOnly),
        }).toEqual({ query, pages: observedPages(without, query, teamOnly) });
      }
      // The word a hidden name holds is corrected to the visible one, as if the hidden names were not there.
      expect(
        observed(withHidden, "zephyrine", teamOnly).hits.map(
          (hit) => `${hit.match} ${hit.path}`,
        ),
      ).toEqual(["fuzzy team/zephyrina", "fuzzy team/zephyrina notes.txt"]);
      // Each reading still finds what the caller may see.
      for (const [query, path] of [
        ["crème", "team/creme notes 20240315.md"],
        ["15-03-2024", "team/creme notes 20240315.md"],
        ["backup_photos", "team/backupPhotos.sh"],
        ["zürich", "team/zurich.txt"],
      ])
        expect(
          observed(withHidden, query ?? "", teamOnly).hits.map(
            (hit) => hit.path,
          ),
        ).toContain(path);
      // Someone who can read the secret folder finds it as typed.
      expect(namedHits(withHidden, "zephyrine", { type: "all" })).toContain(
        "name secret/zephyrine plan.txt",
      );
    });
});

describe("accents", () => {
  const composed = "Résumé.pdf";
  const decomposed = "Résumé.pdf";
  function drive() {
    const index = createSearchIndex();
    for (const path of [
      "Recettes/Crème brûlée.md",
      "Menus/cafe.txt",
      "Menus/café.txt",
      "Travel/Zürich 2019/hotel.pdf",
      `People/${composed}`,
      `People/${decomposed}`,
      "Documents/Straße 12 lease.pdf",
    ])
      index.add(path, "file");
    return index;
  }
  const found = (
    index: ReturnType<typeof createSearchIndex>,
    query: string,
    depth: "instant" | "full" = "full",
  ) =>
    index
      .search({ query, root: "", limit: 50, scope: all, depth, now: 1 })
      .hits.map((hit) => hit.path);

  for (const compacted of [false, true])
    describe(compacted ? "compacted" : "before compaction", () => {
      const index = drive();
      if (compacted) index.compact();

      it("finds accented names typed without accents, while typing too", () => {
        expect(found(index, "creme brulee", "instant")).toEqual([
          "Recettes/Crème brûlée.md",
        ]);
        expect(found(index, "strasse")).toEqual([
          "Documents/Straße 12 lease.pdf",
        ]);
        expect(found(index, "zurich hotel")).toEqual([
          "Travel/Zürich 2019/hotel.pdf",
        ]);
      });

      it("ranks the name as typed, accents included, first", () => {
        expect(found(index, "café")).toEqual([
          "Menus/café.txt",
          "Menus/cafe.txt",
        ]);
        expect(found(index, "cafe")).toEqual([
          "Menus/cafe.txt",
          "Menus/café.txt",
        ]);
      });

      it("keeps names that differ only in accents or composition apart, as on disk", () => {
        expect(found(index, "resume").sort()).toEqual(
          [`People/${composed}`, `People/${decomposed}`].sort(),
        );
        expect(found(index, "résumé")).toHaveLength(2);
      });

      it("corrects typos across accents", () => {
        expect(found(index, "brulle")).toEqual(["Recettes/Crème brûlée.md"]);
      });
    });
});

describe("dates", () => {
  function drive() {
    const index = createSearchIndex();
    for (const path of [
      "Scans/receipt 2024-03-15 costco.pdf",
      "Photos/IMG_20240315_1015.jpg",
      "Work/notes 2024.03.15.txt",
      "Scans/visa 2024-04-03.pdf",
      "Logs/20230704.log",
      "Photos/2023-07-04 fireworks.jpg",
      "Reports/report 2024.pdf",
      "Scans/statement 2024-03.pdf",
    ])
      index.add(path, "file");
    return index;
  }
  const found = (index: ReturnType<typeof createSearchIndex>, query: string) =>
    index
      .search({ query, root: "", limit: 50, scope: all, depth: "full", now: 1 })
      .hits.map((hit) => hit.path);

  for (const compacted of [false, true])
    describe(compacted ? "compacted" : "before compaction", () => {
      const index = drive();
      if (compacted) index.compact();

      it("finds a day written any way, below names with it as typed", () => {
        expect(found(index, "15-03-2024").sort()).toEqual([
          "Photos/IMG_20240315_1015.jpg",
          "Scans/receipt 2024-03-15 costco.pdf",
          "Work/notes 2024.03.15.txt",
        ]);
        expect(found(index, "20230704")).toEqual([
          "Logs/20230704.log",
          "Photos/2023-07-04 fireworks.jpg",
        ]);
        expect(found(index, "2024_03_15 costco")).toEqual([
          "Scans/receipt 2024-03-15 costco.pdf",
        ]);
      });

      it("reads an ambiguous day both ways", () => {
        expect(found(index, "03-04-2024 visa")).toEqual([
          "Scans/visa 2024-04-03.pdf",
        ]);
      });

      it("finds a month, by number or by name next to a year", () => {
        expect(found(index, "2024-03")[0]).toBe("Scans/statement 2024-03.pdf");
        expect(found(index, "2024-03")).toHaveLength(4);
        expect(found(index, "march 2024 costco")).toEqual([
          "Scans/receipt 2024-03-15 costco.pdf",
        ]);
      });

      it("leaves a bare year a plain number", () => {
        expect(found(index, "2024").sort()).toEqual(
          [
            "Photos/IMG_20240315_1015.jpg",
            "Reports/report 2024.pdf",
            "Scans/receipt 2024-03-15 costco.pdf",
            "Scans/statement 2024-03.pdf",
            "Scans/visa 2024-04-03.pdf",
            "Work/notes 2024.03.15.txt",
          ].sort(),
        );
      });

      it("marks the date as the name writes it", () => {
        const { terms } = index.search({
          query: "15-03-2024",
          root: "",
          limit: 50,
          scope: all,
          depth: "full",
        });
        for (const written of ["2024-03-15", "2024.03.15", "20240315"])
          expect(terms).toContain(written);
      });
    });
});

describe("joined words", () => {
  function drive() {
    const index = createSearchIndex();
    for (const path of [
      "Code/scripts/backup_photos_nightly.sh",
      "Code/photo-sorter/readme.md",
      "Code/web/UserProfileCard.tsx",
      "Hiring/jane_doe_resume.pdf",
      "Hiring/jane smith doe notes.txt",
    ])
      index.add(path, "file");
    return index;
  }
  const found = (index: ReturnType<typeof createSearchIndex>, query: string) =>
    index
      .search({ query, root: "", limit: 50, scope: all, depth: "full", now: 1 })
      .hits.map((hit) => `${hit.match} ${hit.path}`);

  for (const compacted of [false, true])
    describe(compacted ? "compacted" : "before compaction", () => {
      const index = drive();
      if (compacted) index.compact();

      it("reads words joined by case, hyphens, underscores or dots apart", () => {
        expect(found(index, "backupPhotos")).toEqual([
          "words Code/scripts/backup_photos_nightly.sh",
        ]);
        // Only the folder: readme.md holds neither word in its own name.
        expect(found(index, "photoSorter")).toEqual([
          "words Code/photo-sorter",
        ]);
        expect(found(index, "user-profile-card")).toEqual([
          "words Code/web/UserProfileCard.tsx",
        ]);
      });

      it("keeps names holding the query as typed first", () => {
        expect(found(index, "jane_doe")).toEqual([
          "name Hiring/jane_doe_resume.pdf",
          "words Hiring/jane smith doe notes.txt",
        ]);
        expect(found(index, "photo-sorter")[0]).toBe("name Code/photo-sorter");
      });
    });
});
