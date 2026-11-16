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

  it("continues by position after a compaction renumbers the tree", () => {
    const index = createSearchIndex();
    for (let file = 0; file < 10; file++) index.add(`a/note-${file}`, "file");
    index.compact();
    const request: SearchRequest = {
      query: "note",
      root: "",
      limit: 4,
      scope: all,
      depth: "full",
    };
    const first = index.search(request);
    index.compact();
    const second = index.search({
      ...request,
      cursor: first.next ?? undefined,
    });
    expect(second.hits.map((hit) => hit.path)).toEqual(
      index
        .search({ ...request, limit: 8 })
        .hits.slice(4)
        .map((hit) => hit.path),
    );
    expect(second.total).toBe(10);
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
      const found = answer.hits.map((hit) => hit.path);
      expect({ query, root, grants, found: [...found].sort() }).toEqual({
        query,
        root,
        grants,
        found: expected,
      });
      expect(answer.total).toBe(expected.length);
      // Refining in place never reorders the instant results.
      expect(found.slice(0, instant.length)).toEqual(instant);
    }
  });
});
