/**
 * Fewer startup files for the file browser, without heavier pages elsewhere.
 *
 * Rolldown splits every module shared by a different set of routes into its own chunk, so the
 * file browser started with about 63 files, which over HTTP/1.1 and six connections costs more
 * round trips than bytes. The build runs twice: a probe build (`NIMBUS_CHUNK_PROBE=1`) records
 * the emitted chunks, then this plan merges chunks the file browser loads at startup, pair by
 * pair, keeping a merge only when it lowers the file browser's file count and adds no module to
 * any other page's startup beyond `extraRawBudget` bytes (the public sign-in, share and
 * file-request pages always get zero). The real build then groups modules by that plan.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, Rolldown } from "vite";

type Chunk = {
  file: string;
  facade: string | null;
  imports: string[];
  modules: string[];
  bytes: number;
};
type Groups = Map<string, Set<string>>;
type State = { initial: Map<string, Set<string>>; extra: number };
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

/** Whether following imports from some group leads back to it. */
function hasCycle(dependencies: Map<string, Set<string>>) {
  const done = new Set<string>();
  const active = new Set<string>();
  const visit = (group: string): boolean => {
    if (done.has(group)) return false;
    if (active.has(group)) return true;
    active.add(group);
    for (const dependency of dependencies.get(group) ?? [])
      if (visit(dependency)) return true;
    active.delete(group);
    done.add(group);
    return false;
  };
  return [...dependencies.keys()].some(visit);
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
  const closure = (file: string, into: Set<string>) => {
    if (into.has(file)) return;
    const chunk = byFile.get(file);
    if (!chunk)
      throw new Error(
        `Chunk probe references missing JavaScript chunk ${file}.`,
      );
    into.add(file);
    for (const imported of chunk.imports)
      if (byFile.has(imported)) closure(imported, into);
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
  // Other HTML entries, such as the public share page, are protected pages of their own.
  for (const chunk of chunks) {
    if (
      !chunk.facade?.endsWith(".html") ||
      chunk.facade === path.join(root, "index.html")
    )
      continue;
    const files = new Set<string>();
    closure(chunk.file, files);
    const name = "entry:" + path.relative(root, chunk.facade);
    pages.set(name, files);
    protectedPages.add(name);
  }
  const browse = pages.get("/browse/$");
  if (!browse)
    throw new Error(
      "Chunk probe has no /browse/$ component entry. Check TanStack Router splitting.",
    );
  let groups: Groups = new Map();
  for (const chunk of chunks) {
    const consumers = [...pages]
      .filter(([, files]) => files.has(chunk.file))
      .map(([page]) => page)
      .sort(compare);
    const key =
      chunk.facade || consumers.length === 0
        ? "facade:" + chunk.file
        : "pages:" + consumers.join(",");
    const files = groups.get(key) ?? new Set<string>();
    files.add(chunk.file);
    groups.set(key, files);
  }
  const simulate = (candidate: Groups): State | null => {
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
    if (hasCycle(dependencies)) return null;
    const initial = new Map<string, Set<string>>();
    let extra = 0;
    for (const [page, files] of pages) {
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
      let added = 0;
      for (const group of seen)
        for (const file of candidate.get(group) ?? [])
          if (!files.has(file)) added += byFile.get(file)?.bytes ?? 0;
      if (protectedPages.has(page) && added > 0) return null;
      extra = Math.max(extra, added);
      initial.set(page, seen);
    }
    return { initial, extra };
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
    if (!current)
      throw new Error(
        "Initial page groups add modules to a protected route or import each other in a cycle. Check the chunk probe output.",
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
        const count = state?.initial.get("/browse/$")?.size;
        if (
          !state ||
          count === undefined ||
          state.extra > budget ||
          count >= initial.size
        )
          continue;
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
        if (!probe) return;
        const chunks: Chunk[] = [];
        for (const output of Object.values(bundle))
          if (output.type === "chunk")
            chunks.push({
              file: output.fileName,
              facade: output.facadeModuleId,
              imports: output.imports,
              modules: Object.keys(output.modules),
              bytes: Buffer.byteLength(output.code),
            });
        mkdirSync(path.dirname(planFile), { recursive: true });
        writeFileSync(
          planFile,
          JSON.stringify(planGroups(chunks, root, extraRawBudget), null, 2) +
            "\n",
        );
      },
    },
  };
}
