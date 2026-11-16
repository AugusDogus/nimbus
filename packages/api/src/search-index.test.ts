import { describe, expect, it } from "bun:test";
import { createSearchIndex, type SearchScope } from "./search-index";

const all: SearchScope = { type: "all" };
const paths = (
  index: ReturnType<typeof createSearchIndex>,
  query: string,
  scope: SearchScope = all,
  root = "",
  limit = 50,
) => index.search({ query, root, limit, scope }).hits.map((hit) => hit.path);

function sample() {
  const index = createSearchIndex(4);
  index.add("docs", "dir");
  index.add("docs/Report.pdf", "file");
  index.add("docs/annual report 2026.txt", "file");
  index.add("docs/reports", "dir");
  index.add("docs/reports/q1.csv", "file");
  index.add("photos/Café.JPG", "file");
  index.add("photos/misreported.png", "file");
  return index;
}

describe("search index", () => {
  it("matches case-insensitively and ranks exact, then shorter prefix, word and infix matches", () => {
    for (const compacted of [false, true]) {
      const index = sample();
      if (compacted) index.compact();
      expect(paths(index, "REPORT")).toEqual([
        "docs/reports",
        "docs/Report.pdf",
        "docs/annual report 2026.txt",
        "photos/misreported.png",
      ]);
      expect(paths(index, "reports")).toEqual(["docs/reports"]);
      expect(paths(index, "q1.csv")).toEqual(["docs/reports/q1.csv"]);
    }
  });

  it("normalizes Unicode so composed and decomposed names match", () => {
    const index = sample();
    index.compact();
    expect(paths(index, "café")).toEqual(["photos/Café.JPG"]);
    expect(
      index.search({ query: "zzz", root: "", limit: 50, scope: all }).hits,
    ).toEqual([]);
  });

  it("reports types and truncation at the limit", () => {
    const index = sample();
    expect(
      index.search({ query: "report", root: "", limit: 2, scope: all }),
    ).toEqual({
      hits: [
        { path: "docs/reports", type: "dir" },
        { path: "docs/Report.pdf", type: "file" },
      ],
      truncated: true,
    });
    expect(
      index.search({ query: "q1", root: "", limit: 1, scope: all }).truncated,
    ).toBe(false);
  });

  it("returns only entries inside the caller's grants and the requested root", () => {
    const index = sample();
    index.compact();
    expect(
      paths(index, "report", { type: "grants", paths: ["docs/reports"] }),
    ).toEqual(["docs/reports"]);
    expect(
      paths(index, "q1", { type: "grants", paths: ["docs/reports"] }),
    ).toEqual(["docs/reports/q1.csv"]);
    expect(
      paths(index, "report", { type: "grants", paths: ["photos"] }),
    ).toEqual(["photos/misreported.png"]);
    expect(
      paths(index, "report", { type: "grants", paths: ["missing"] }),
    ).toEqual([]);
    expect(paths(index, "report", all, "docs/reports")).toEqual([]);
    expect(paths(index, "q1", all, "docs")).toEqual(["docs/reports/q1.csv"]);
  });

  it("removes subtrees, including entries that were already compacted", () => {
    const index = sample();
    index.compact();
    index.remove("docs/reports");
    expect(paths(index, "q1")).toEqual([]);
    expect(index.has("docs/reports/q1.csv")).toBe(false);
    expect(index.size).toBe(6);
    index.add("archive/reports/q1.csv", "file");
    expect(paths(index, "q1")).toEqual(["archive/reports/q1.csv"]);
  });

  it("replaces an entry whose kind changed", () => {
    const index = sample();
    index.add("docs/Report.pdf", "dir");
    index.add("docs/Report.pdf/inner.txt", "file");
    expect(index.kindOf("docs/Report.pdf")).toBe("dir");
    expect(paths(index, "inner")).toEqual(["docs/Report.pdf/inner.txt"]);
  });

  it("handles deep trees without recursion limits", () => {
    const index = createSearchIndex();
    const deep = Array.from({ length: 20_000 }, (_, i) => `d${i}`).join("/");
    index.add(`${deep}/needle.txt`, "file");
    expect(paths(index, "needle")).toEqual([`${deep}/needle.txt`]);
    index.remove("d0");
    expect(index.size).toBe(0);
  });
});

describe("search index against a brute-force oracle", () => {
  it("agrees through random adds, removes, compactions and scopes", () => {
    let seed = 7;
    const random = () =>
      (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(random() * items.length)];
    const parts = [
      "Alpha",
      "beta",
      "Gamma ray",
      "delta_x",
      "épsilon",
      "zeta.txt",
      "eta-1",
      "θeta",
    ];
    const index = createSearchIndex(2);
    const oracle = new Map<string, "file" | "dir">();
    const within = (parent: string, child: string) =>
      parent === "" || child === parent || child.startsWith(`${parent}/`);
    for (let step = 0; step < 3000; step++) {
      const dirs = [
        "",
        ...[...oracle]
          .filter(([, kind]) => kind === "dir")
          .map(([path]) => path),
      ];
      const action = random();
      if (action < 0.6) {
        const base = pick(dirs);
        const path = `${base ? `${base}/` : ""}${pick(parts)}${Math.floor(random() * 3)}`;
        const kind = random() < 0.4 ? "dir" : "file";
        for (const existing of [...oracle.keys()])
          if (existing === path || existing.startsWith(`${path}/`))
            if (oracle.get(path) !== kind) oracle.delete(existing);
        oracle.set(path, kind);
        index.add(path, kind);
      } else if (action < 0.75 && oracle.size) {
        const path = pick([...oracle.keys()]);
        for (const existing of [...oracle.keys()])
          if (within(path, existing)) oracle.delete(existing);
        index.remove(path);
      } else if (action < 0.8) index.compact();
      if (step % 50 !== 0) continue;
      const query = pick(["a", "e", "ta", "eta", "ÉPS", "ray", "x1", "θ"]);
      const root = pick(dirs);
      const grants = random() < 0.5 ? null : [pick(dirs), pick(dirs)];
      const folded = query.normalize("NFC").toLowerCase();
      const expected = [...oracle.keys()]
        .filter((path) => {
          const name = path
            .slice(path.lastIndexOf("/") + 1)
            .normalize("NFC")
            .toLowerCase();
          const matches =
            folded.length === 1
              ? name.startsWith(folded)
              : name.includes(folded);
          return (
            matches &&
            path !== root &&
            within(root, path) &&
            (grants === null || grants.some((grant) => within(grant, path)))
          );
        })
        .sort();
      const scope: SearchScope =
        grants === null ? { type: "all" } : { type: "grants", paths: grants };
      const actual = index.search({ query, root, limit: 10_000, scope });
      expect(actual.hits.map((hit) => hit.path).sort()).toEqual(expected);
      expect(
        actual.hits.every((hit) => oracle.get(hit.path) === hit.type),
      ).toBe(true);
      expect(actual.truncated).toBe(false);
    }
  });
});
