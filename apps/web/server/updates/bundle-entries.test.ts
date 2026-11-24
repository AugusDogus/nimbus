import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { BUNDLE_ENTRIES } from "./bundle-entries";

const web = path.resolve(import.meta.dir, "../..");

test("every worker the server starts is a bundle entry", async () => {
  const started = new Set<string>();
  const sources = (
    await readdir(path.join(web, "server"), { recursive: true })
  ).filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.test\.tsx?$|testing\.ts$|\/bench\//.test(file),
  );
  for (const file of sources) {
    const text = await Bun.file(path.join(web, "server", file)).text();
    for (const match of text.matchAll(
      /new Worker\(\s*new URL\(\s*"([^"]+)"/g,
    )) {
      const worker = match[1];
      if (worker)
        started.add(
          path.relative(
            web,
            path.join(web, "server", path.dirname(file), worker),
          ),
        );
    }
  }
  expect(started.size).toBeGreaterThan(0);
  const entries: readonly string[] = BUNDLE_ENTRIES;
  for (const worker of started) expect(entries).toContain(worker);
});
