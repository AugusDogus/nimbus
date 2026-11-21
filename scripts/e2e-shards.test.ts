import { expect, test } from "bun:test";
import {
  fileSeconds,
  parseTimings,
  partitionProblems,
  plan,
  reportTests,
  specFiles,
} from "./e2e-shards";

test("balances whole files by recorded duration, heaviest first", () => {
  const shards = plan(
    ["a.e2e.ts", "b.e2e.ts", "c.e2e.ts", "d.e2e.ts", "e.e2e.ts"],
    {
      "a.e2e.ts": 100,
      "b.e2e.ts": 60,
      "c.e2e.ts": 50,
      "d.e2e.ts": 30,
      "e.e2e.ts": 20,
    },
    2,
  );
  expect(shards).toEqual([
    { files: ["a.e2e.ts", "d.e2e.ts"], seconds: 130 },
    { files: ["b.e2e.ts", "c.e2e.ts", "e.e2e.ts"], seconds: 130 },
  ]);
});

test("plans the same shards whatever order the files arrive in", () => {
  const timings = { "a.e2e.ts": 10, "b.e2e.ts": 10, "c.e2e.ts": 10 };
  const files = ["a.e2e.ts", "b.e2e.ts", "c.e2e.ts", "d.e2e.ts"];
  expect(plan([...files].reverse(), timings, 3)).toEqual(
    plan(files, timings, 3),
  );
});

test("weighs files without a recorded duration at the median and never drops them", () => {
  const shards = plan(
    ["new.e2e.ts", "a.e2e.ts", "b.e2e.ts", "c.e2e.ts"],
    { "a.e2e.ts": 10, "b.e2e.ts": 40, "c.e2e.ts": 90, "gone.e2e.ts": 1000 },
    2,
  );
  // The median of 10, 40, 90 and 1000 is 65.
  expect(shards).toEqual([
    { files: ["a.e2e.ts", "c.e2e.ts"], seconds: 100 },
    { files: ["b.e2e.ts", "new.e2e.ts"], seconds: 105 },
  ]);
});

test("leaves a shard empty when there are fewer files than shards, which the guard reports", () => {
  const shards = plan(["a.e2e.ts"], {}, 2);
  expect(shards.map((shard) => shard.files)).toEqual([["a.e2e.ts"], []]);
  expect(partitionProblems(["a.e2e.ts"], shards)).toEqual([
    "Shard 2 has no spec files.",
  ]);
});

test("rejects a shard count that is not a positive integer", () => {
  expect(() => plan(["a.e2e.ts"], {}, 0)).toThrow(RangeError);
  expect(() => plan(["a.e2e.ts"], {}, 1.5)).toThrow(RangeError);
});

test("reports files in two shards, files in none and files Playwright does not discover", () => {
  expect(
    partitionProblems(
      ["a.e2e.ts", "b.e2e.ts", "c.e2e.ts"],
      [
        { files: ["a.e2e.ts", "b.e2e.ts"], seconds: 0 },
        { files: ["b.e2e.ts", "old.e2e.ts"], seconds: 0 },
      ],
    ),
  ).toEqual([
    "b.e2e.ts is in shards 1 and 2.",
    "old.e2e.ts is in shard 2, but Playwright does not discover it.",
    "c.e2e.ts is in no shard.",
  ]);
  expect(
    partitionProblems(
      ["a.e2e.ts", "b.e2e.ts"],
      [
        { files: ["a.e2e.ts"], seconds: 0 },
        { files: ["b.e2e.ts"], seconds: 0 },
      ],
    ),
  ).toEqual([]);
});

const report = {
  config: {},
  errors: [],
  suites: [
    {
      title: "auth.setup.ts",
      file: "auth.setup.ts",
      specs: [
        {
          file: "auth.setup.ts",
          tests: [{ projectName: "setup", results: [{ duration: 5000 }] }],
        },
      ],
    },
    {
      title: "files.e2e.ts",
      file: "files.e2e.ts",
      specs: [
        {
          file: "files.e2e.ts",
          tests: [
            { projectName: "desktop", results: [{ duration: 1200 }] },
            { projectName: "mobile", results: [{ duration: 800 }] },
          ],
        },
      ],
      suites: [
        {
          title: "nested",
          file: "files.e2e.ts",
          specs: [
            {
              file: "files.e2e.ts",
              tests: [
                {
                  projectName: "desktop",
                  results: [{ duration: 1000 }, { duration: 1049 }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: "layout.e2e.ts",
      file: "layout.e2e.ts",
      specs: [
        {
          file: "layout.e2e.ts",
          tests: [{ projectName: "mobile", results: [] }],
        },
      ],
    },
  ],
};

test("reads spec files and per-file seconds from a Playwright JSON report, leaving out setup", () => {
  const tests = reportTests(report);
  expect(specFiles(tests)).toEqual(["files.e2e.ts", "layout.e2e.ts"]);
  expect(fileSeconds(tests)).toEqual({
    "files.e2e.ts": 4,
    "layout.e2e.ts": 0,
  });
});

test("refuses a report with load errors or an unexpected shape", () => {
  expect(() =>
    reportTests({ ...report, errors: [{ message: "boom" }] }),
  ).toThrow(/1 error\(s\) loading the tests/);
  expect(() => reportTests({ suites: [{ specs: [{ tests: [] }] }] })).toThrow(
    /malformed spec/,
  );
  expect(() => reportTests([])).toThrow(/malformed report/);
});

test("accepts only non-negative second counts as timings", () => {
  expect(parseTimings({ "a.e2e.ts": 1.5 }, "timings.json")).toEqual({
    "a.e2e.ts": 1.5,
  });
  expect(() => parseTimings({ "a.e2e.ts": "1" }, "timings.json")).toThrow(
    /records "1" for a.e2e.ts/,
  );
  expect(() => parseTimings({ "a.e2e.ts": -1 }, "timings.json")).toThrow();
  expect(() => parseTimings([], "timings.json")).toThrow();
});
