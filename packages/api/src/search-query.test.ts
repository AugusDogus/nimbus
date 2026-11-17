import { describe, expect, it } from "bun:test";
import { createSearchIndex, type SearchScope } from "./search-index";
import type { HistoryEntry, SearchRequest } from "./search-query";

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
      const { all: seen, restarted } = pages(index, request, (page) => {
        if (page % 2 === 1) index.compact();
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
    const { all: seen, restarted } = pages(index, request, () => {
      index.compact();
      index.compact();
    });
    expect(restarted).toBeGreaterThan(0);
    expect([...new Set(seen.flat())].sort()).toEqual(
      index
        .search({ ...request, limit: 1000 })
        .hits.map((hit) => hit.path)
        .sort(),
    );
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

  it("starts over for a cursor no page returned", () => {
    const index = drive();
    expect(
      index.search({
        query: "notes",
        root: "",
        limit: 50,
        scope: all,
        cursor: "not-a-cursor",
      }).hits,
    ).toHaveLength(3);
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
      if (step % 40 !== 0) continue;
      const query =
        pick([
          "alpha beta",
          "2024 ray",
          "gamma/delta",
          "a 2024",
          "zeta épsilon",
          "beta1 alpha0",
          "eta",
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
      // Typo matches (the fuzzy layer) come after, and only when few matched strictly.
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
      if (expected.length >= 10) expect(fuzzy).toEqual([]);
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

  it("stays out of the way once ten or more names match strictly", () => {
    const index = createSearchIndex();
    for (let i = 0; i < 10; i++) index.add(`notes/note-${i}.txt`, "file");
    index.add("other/nots.txt", "file");
    index.compact();
    expect(hits(index, "note")).toHaveLength(11);
    expect(
      hits(index, "note").filter((hit) => hit.startsWith("fuzzy")),
    ).toEqual([]);
    index.remove("notes/note-9.txt");
    expect(hits(index, "note.txt")).toEqual([]);
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
  ];
  const visibleNames = [
    "team/zephyrina notes.txt",
    "team/zephyrina/agenda.md",
    "team/budget 2026.xlsx",
    "team/notes.txt",
  ];
  function drive(withHidden: boolean, compacted: boolean) {
    const index = createSearchIndex();
    for (const path of [...(withHidden ? hiddenNames : []), ...visibleNames])
      index.add(path, "file");
    if (compacted) index.compact();
    return index;
  }
  const teamOnly: SearchScope = { type: "grants", paths: ["team"] };
  /** Everything a caller observes of a result, except the opaque cursor's contents. */
  const observed = (
    index: ReturnType<typeof createSearchIndex>,
    query: string,
    scope: SearchScope,
  ) => {
    const answer = index.search({
      query,
      root: "",
      limit: 2,
      scope,
      depth: "full",
      now: 1,
    });
    return {
      hits: answer.hits,
      total: answer.total,
      truncated: answer.truncated,
      more: answer.next !== null,
      terms: answer.terms,
    };
  };

  const namedHits = (
    index: ReturnType<typeof createSearchIndex>,
    query: string,
    scope: SearchScope,
  ) =>
    index
      .search({ query, root: "", limit: 50, scope, depth: "full", now: 1 })
      .hits.map((hit) => `${hit.match} ${hit.path}`);

  for (const compacted of [false, true])
    it(`for exact and misspelled words, ${compacted ? "compacted" : "before compaction"}`, () => {
      const withHidden = drive(true, compacted);
      const without = drive(false, compacted);
      for (const query of [
        "zephyrine",
        "zephyrinne",
        "zephyrine notes",
        "zephyrnie agenda",
        "codename budget",
        "budgte",
        "notes",
      ]) {
        expect({ query, ...observed(withHidden, query, teamOnly) }).toEqual({
          query,
          ...observed(without, query, teamOnly),
        });
      }
      // The word a hidden name holds is corrected to the visible one, as if the hidden names were not there.
      expect(
        observed(withHidden, "zephyrine", teamOnly).hits.map(
          (hit) => `${hit.match} ${hit.path}`,
        ),
      ).toEqual(["fuzzy team/zephyrina", "fuzzy team/zephyrina notes.txt"]);
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
