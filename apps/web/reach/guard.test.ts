import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { deviceModules, pending, vendored } from "./allowlist";
import { ReachGuard } from "./guard";

const app = path.resolve(import.meta.dir, "..");
const scan = (source: string) =>
  ReachGuard.scan(source, { mayReadWindow: false }).map(
    ({ line, rule }) => `${line}: ${rule}`,
  );

describe("ReachGuard.scan", () => {
  test("flags a button hidden below a breakpoint", () => {
    expect(
      scan(`
        <Button
          className="touch-hit md:hidden"
          onClick={open}
        >
          New
        </Button>`),
    ).toEqual(["3: control hidden by width"]);
  });

  test("flags a wrapper that hides the controls inside it until a breakpoint", () => {
    expect(
      scan(`
      <div className="hidden md:flex">
        <Select value={sort}>
          <SelectTrigger />
        </Select>
      </div>`),
    ).toEqual(["2: control hidden by width"]);
  });

  test("flags stacked variants and classes kept in a constant", () => {
    expect(
      scan(`
      <Button className="max-md:pointer-coarse:sr-only" />
      const hide = folded ? "hidden" : "max-lg:hidden";`),
    ).toEqual(["2: control hidden by width", "3: control hidden by width"]);
  });

  test("passes a reason comment on the line or above it, or above the element", () => {
    expect(
      scan(`
      {/* reach: the sort drawer offers sorting below md */}
      <div className="hidden md:flex">
        <Button onClick={sort} />
      </div>
      <Button
        // reach: the sidebar's New button
        className="md:hidden"
        onClick={open}
      />`),
    ).toEqual([]);
  });

  test("passes text, labels inside a button, pointer variants and container queries", () => {
    expect(
      scan(`
      <p className="text-sm sm:hidden">Shared by Robin</p>
      <span className="max-sm:sr-only">New folder</span>
      <Button className="pointer-fine:opacity-0 @max-lg:hidden any-pointer-fine:hidden" />
      <Button className={folded ? "hidden" : undefined} />`),
    ).toEqual([]);
  });

  test("flags reading the window outside the Device module", () => {
    expect(
      scan(`
      const wide = matchMedia("(min-width: 1024px)").matches;
      const width = window.innerWidth;
      // matchMedia in a comment is fine
      const ok = matchMedia(query); // reach: colour scheme, not a device question`),
    ).toEqual(["2: reads the window", "3: reads the window"]);
  });
});

const isVendored = (file: string) =>
  vendored.some((entry) => file === entry.path || file.startsWith(entry.path));

test("feature code decides reach through the Device module, or says where else a control is", async () => {
  const files: string[] = [];
  for (const root of ["app", "components", "routes", "client", "hooks", "lib"])
    for await (const file of new Bun.Glob(`${root}/**/*.{ts,tsx}`).scan({
      cwd: app,
    }))
      if (!/\.test\.tsx?$/.test(file) && !isVendored(file)) files.push(file);
  expect(files.length).toBeGreaterThan(100);
  const used = new Set<(typeof pending)[number]>();
  const problems: string[] = [];
  for (const file of files.sort()) {
    const source = await readFile(path.join(app, file), "utf8");
    const findings = ReachGuard.scan(source, {
      mayReadWindow: deviceModules.some((entry) => entry.path === file),
    });
    for (const finding of findings) {
      const allowed = pending.find(
        (entry) => entry.path === file && entry.line === finding.text,
      );
      if (allowed) used.add(allowed);
      else
        problems.push(
          `apps/web/${file}:${finding.line} ${finding.rule}: ${finding.text}`,
        );
    }
  }
  expect(
    problems,
    "Ask the Device module (apps/web/lib/device.ts) instead, or add a `// reach: <the other route>` comment on the line or the line above it. Lines owned by other work go in apps/web/reach/allowlist.ts.",
  ).toEqual([]);
  expect(
    pending.filter((entry) => !used.has(entry)).map((entry) => entry.path),
    "These allowlist entries no longer match a line: remove them from apps/web/reach/allowlist.ts.",
  ).toEqual([]);
});
