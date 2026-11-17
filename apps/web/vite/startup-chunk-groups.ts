/**
 * Fewer startup files for the file browser, without heavier pages elsewhere.
 *
 * Rolldown splits every module shared by a different set of routes into its own chunk, so the
 * file browser started with about 63 files, which over HTTP/1.1 and six connections costs more
 * round trips than bytes. The build runs twice: a probe build (`NIMBUS_CHUNK_PROBE=1`) records
 * the emitted chunks, then this plan merges chunks the file browser loads at startup, pair by
 * pair, keeping a merge only when it lowers the file browser's file count and adds no module to
 * any other page's startup, or to what the app loads on every page right after it starts,
 * beyond `extraRawBudget` bytes (the sign-in, share and file-request pages always get zero,
 * at startup and later). The real build then groups modules by that plan.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, Rolldown } from "vite";

type Chunk = {
  file: string;
  facade: string | null;
  imports: string[];
  dynamicImports: string[];
  modules: string[];
  bytes: number;
};
type Groups = Map<string, Set<string>>;
/** A grouping's startup files per page and the most bytes it adds to any page, or why not. */
type State =
  | {
      kind: "valid";
      initial: Map<string, Set<string>>;
      extra: number;
      /** Bytes of other code each checked page loads, by page. */
      added: Map<string, number>;
    }
  | { kind: "rejected"; reason: string };
const protectedRoutes = new Set([
  "/login",
  "/signup",
  "/reset-password",
  "/s/$token",
  "/r/$token",
]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const hash = (files: Set<string>) =>
  createHash("sha1")
    .update([...files].sort(compare).join(","))
    .digest("hex")
    .slice(0, 8);

/** A cycle of groups that import each other, or null when following imports never loops. */
function findCycle(dependencies: Map<string, Set<string>>): string[] | null {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (group: string): string[] | null => {
    if (done.has(group)) return null;
    const start = path.indexOf(group);
    if (start !== -1) return [...path.slice(start), group];
    path.push(group);
    for (const dependency of dependencies.get(group) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(group);
    return null;
  };
  for (const group of dependencies.keys()) {
    const cycle = visit(group);
    if (cycle) return cycle;
  }
  return null;
}

function planGroups(
  chunks: Chunk[],
  root: string,
  budget: number,
): Record<string, string> {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const protectedPages = new Set(protectedRoutes);
  const entry = chunks.find(
    (chunk) => chunk.facade === path.join(root, "index.html"),
  );
  if (!entry)
    throw new Error(
      "Chunk probe has no index.html entry. Keep HTML entry modules outside manual groups.",
    );
  const suffix = "?tsr-split=component";
  const routeEntries = new Map<string, string>();
  for (const chunk of chunks) {
    if (!chunk.facade) continue;
    const relative = path.relative(root, chunk.facade).replaceAll("\\", "/");
    if (relative.startsWith("routes/") && relative.endsWith(suffix))
      routeEntries.set(relative.slice(0, -suffix.length), chunk.file);
  }
  /** Adds the files `file` loads to `into`: by static import, and also by `import()` if `later`. */
  const closure = (file: string, into: Set<string>, later = false) => {
    if (into.has(file)) return;
    const chunk = byFile.get(file);
    if (!chunk)
      throw new Error(
        `Chunk probe references missing JavaScript chunk ${file}.`,
      );
    into.add(file);
    for (const imported of chunk.imports)
      if (byFile.has(imported)) closure(imported, into, later);
    if (later)
      for (const imported of chunk.dynamicImports)
        if (byFile.has(imported)) closure(imported, into, later);
  };
  const pages = new Map<string, Set<string>>();
  for (const route of routeEntries.keys()) {
    if (
      [...routeEntries.keys()].some((other) =>
        other.startsWith(route.slice(0, -4) + "/"),
      )
    )
      continue;
    const parts = route.slice(0, -4).split("/");
    const files = new Set<string>();
    closure(entry.file, files);
    for (let depth = 2; depth <= parts.length; depth++) {
      const file = routeEntries.get(parts.slice(0, depth).join("/") + ".tsx");
      if (file) closure(file, files);
    }
    pages.set(
      "/" +
        parts
          .slice(1)
          .filter((part) => !part.startsWith("_") && part !== "index")
          .join("/"),
      files,
    );
  }
  // Other HTML entries, sign-in and the public share and upload pages, are protected pages of
  // their own twice over: what they load at startup, and everything they can load later, so
  // neither grows and no file they ever fetch holds code of another page.
  for (const chunk of chunks) {
    if (
      !chunk.facade?.endsWith(".html") ||
      chunk.facade === path.join(root, "index.html")
    )
      continue;
    const name = "entry:" + path.relative(root, chunk.facade);
    const startup = new Set<string>();
    closure(chunk.file, startup);
    const everything = new Set<string>();
    closure(chunk.file, everything, true);
    pages.set(name, startup);
    pages.set(`${name} later`, everything);
    protectedPages.add(name);
    protectedPages.add(`${name} later`);
  }
  // What the app entry loads on every page right after it starts, such as the toast UI, is
  // checked like a page, so no merge adds another page's code to what it fetches. In grouping it
  // separates only the signed-in app's files, so the files protected pages share stay whole.
  const checked = new Map(pages);
  const routeFiles = new Set(routeEntries.values());
  const afterStart = new Set<string>();
  for (const file of entry.dynamicImports)
    if (byFile.has(file) && !routeFiles.has(file)) closure(file, afterStart);
  if (afterStart.size > 0)
    checked.set("entry:index.html after start", afterStart);
  const browse = pages.get("/browse/$");
  if (!browse)
    throw new Error(
      "Chunk probe has no /browse/$ component entry. Check TanStack Router splitting.",
    );
  // The entry's own imports start before any route's, and route code imports the entry, so the
  // two never share a group even when the same pages load both.
  const entryFiles = new Set<string>();
  closure(entry.file, entryFiles);
  let groups: Groups = new Map();
  for (const chunk of chunks) {
    const consumers = [...pages]
      .filter(([, files]) => files.has(chunk.file))
      .map(([page]) => page)
      .sort(compare);
    const later =
      afterStart.has(chunk.file) &&
      !consumers.some((page) => protectedPages.has(page))
        ? ",after start"
        : "";
    const key =
      chunk.facade || consumers.length === 0
        ? "facade:" + chunk.file
        : `pages:${entryFiles.has(chunk.file) ? "entry:" : ""}${consumers.join(",")}${later}`;
    const files = groups.get(key) ?? new Set<string>();
    files.add(chunk.file);
    groups.set(key, files);
  }
  const simulate = (candidate: Groups): State => {
    const owner = new Map<string, string>();
    for (const [group, files] of candidate)
      for (const file of files) owner.set(file, group);
    const dependencies = new Map<string, Set<string>>();
    for (const [group, files] of candidate) {
      const deps = new Set<string>();
      for (const file of files)
        for (const imported of byFile.get(file)?.imports ?? []) {
          const dep = owner.get(imported);
          if (dep && dep !== group) deps.add(dep);
        }
      dependencies.set(group, deps);
    }
    // Groups that import each other in a cycle can run a module before the one it needs.
    const cycle = findCycle(dependencies);
    if (cycle)
      return {
        kind: "rejected",
        reason: `import each other in a cycle: ${cycle.join(" -> ")}`,
      };
    const initial = new Map<string, Set<string>>();
    const added = new Map<string, number>();
    let extra = 0;
    for (const [page, files] of checked) {
      const seen = new Set<string>();
      for (const file of files) {
        const group = owner.get(file);
        if (group) seen.add(group);
      }
      const stack = [...seen];
      while (stack.length) {
        const group = stack.pop();
        if (group === undefined) break;
        for (const dependency of dependencies.get(group) ?? [])
          if (!seen.has(dependency)) {
            seen.add(dependency);
            stack.push(dependency);
          }
      }
      let bytes = 0;
      for (const group of seen)
        for (const file of candidate.get(group) ?? [])
          if (!files.has(file)) bytes += byFile.get(file)?.bytes ?? 0;
      if (protectedPages.has(page) && bytes > 0)
        return {
          kind: "rejected",
          reason: `add ${bytes} bytes to the protected page ${page}`,
        };
      extra = Math.max(extra, bytes);
      added.set(page, bytes);
      initial.set(page, seen);
    }
    return { kind: "valid", initial, extra, added };
  };
  const scoreBefore = (
    a: [number, number, string, string],
    b: [number, number, string, string],
  ) =>
    a[0] !== b[0]
      ? a[0] < b[0]
      : a[1] !== b[1]
        ? a[1] < b[1]
        : a[2] !== b[2]
          ? compare(a[2], b[2]) < 0
          : compare(a[3], b[3]) < 0;
  for (;;) {
    const current = simulate(groups);
    if (current.kind === "rejected")
      throw new Error(
        `The initial startup chunk groups ${current.reason}. Nothing was built; check the chunk probe output in node_modules/.cache.`,
      );
    const initial = current.initial.get("/browse/$") ?? new Set<string>();
    const eligible = [...initial]
      .filter((group) => !group.startsWith("facade:"))
      .sort(compare);
    let best:
      | { score: [number, number, string, string]; groups: Groups }
      | undefined;
    for (let i = 0; i < eligible.length; i++)
      for (let j = i + 1; j < eligible.length; j++) {
        const first = eligible[i];
        const second = eligible[j];
        if (first === undefined || second === undefined) continue;
        const candidate = new Map(
          [...groups].filter(([key]) => key !== first && key !== second),
        );
        candidate.set(
          first,
          new Set([
            ...(groups.get(first) ?? []),
            ...(groups.get(second) ?? []),
          ]),
        );
        const state = simulate(candidate);
        if (state.kind === "rejected") continue;
        const count = state.initial.get("/browse/$")?.size;
        // No page may load more of other pages' code than the current plan, plus the budget.
        const heavier = [...state.added].some(
          ([page, bytes]) => bytes > (current.added.get(page) ?? 0) + budget,
        );
        if (count === undefined || heavier || count >= initial.size) continue;
        const score: [number, number, string, string] = [
          count,
          state.extra,
          first,
          second,
        ];
        if (!best || scoreBefore(score, best.score))
          best = { score, groups: candidate };
      }
    if (!best) break;
    groups = best.groups;
  }
  const plan: Record<string, string> = {};
  for (const files of groups.values()) {
    if ([...files].some((file) => byFile.get(file)?.facade)) continue;
    const name = "cohort-" + hash(files);
    for (const file of [...files].sort(compare))
      for (const module of byFile.get(file)?.modules ?? []) plan[module] = name;
  }
  return plan;
}

/** Run a fresh ungrouped probe, then a grouped build from the same source and dependencies. */
export function startupChunkGroups(
  root: string,
  planFile: string,
  extraRawBudget = 65536,
): {
  plugin: Plugin;
  codeSplitting: Rolldown.CodeSplittingOptions | undefined;
} {
  const probe = process.env.NIMBUS_CHUNK_PROBE === "1";
  const names = new Map<string, string>();
  if (!probe) {
    const parsed: unknown = JSON.parse(readFileSync(planFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error(
        "Chunk plan must be an object. Run the ungrouped probe first.",
      );
    for (const [module, name] of Object.entries(parsed)) {
      if (typeof name !== "string")
        throw new Error(
          `Chunk plan has a non-string group for ${module}. Run a fresh probe.`,
        );
      names.set(module, name);
    }
  }
  return {
    codeSplitting: probe
      ? undefined
      : {
          groups: [...new Set(names.values())].map((name) => ({
            name,
            test: (id) => names.get(id) === name,
            includeDependenciesRecursively: false,
          })),
        },
    plugin: {
      name: "nimbus-startup-chunk-plan",
      apply: "build",
      generateBundle(_options, bundle) {
        // Which modules each file holds, for checking what a page loads; see
        // scripts/page-modules.ts.
        const layout = Object.values(bundle).flatMap((output) =>
          output.type === "chunk"
            ? [
                {
                  file: output.fileName,
                  facade: output.facadeModuleId
                    ? path.relative(root, output.facadeModuleId)
                    : null,
                  imports: output.imports,
                  dynamicImports: output.dynamicImports,
                  modules: Object.keys(output.modules).map((id) =>
                    path.relative(root, id),
                  ),
                },
              ]
            : [],
        );
        mkdirSync(path.dirname(planFile), { recursive: true });
        writeFileSync(
          path.join(
            path.dirname(planFile),
            `nimbus-chunk-modules-${probe ? "probe" : "build"}.json`,
          ),
          JSON.stringify(layout) + "\n",
        );
        if (!probe) return;
        const chunks: Chunk[] = [];
        for (const output of Object.values(bundle))
          if (output.type === "chunk")
            chunks.push({
              file: output.fileName,
              facade: output.facadeModuleId,
              imports: output.imports,
              dynamicImports: output.dynamicImports,
              modules: Object.keys(output.modules),
              bytes: Buffer.byteLength(output.code),
            });
        writeFileSync(
          planFile,
          JSON.stringify(planGroups(chunks, root, extraRawBudget), null, 2) +
            "\n",
        );
      },
    },
  };
}
