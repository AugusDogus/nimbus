import { expect, it } from "bun:test";
import { preloadPruning } from "./preload-pruning";

it("leaves out files the importing chunk already loads, and keeps the rest", () => {
  const { record, resolveDependencies } = preloadPruning();
  record(
    Object.entries({
      "assets/index.js": ["assets/shared.js"],
      "assets/shared.js": ["assets/runtime.js"],
      "assets/runtime.js": [],
      "assets/picker.js": ["assets/shared.js", "assets/report.js"],
      "assets/report.js": [],
    }).map(([fileName, imports]) => ({ type: "chunk", fileName, imports })),
  );
  expect(
    resolveDependencies(
      "assets/picker.js",
      [
        "assets/picker.js",
        "assets/shared.js",
        "assets/runtime.js",
        "assets/report.js",
        "assets/picker.css",
      ],
      { hostId: "assets/index.js", hostType: "js" },
    ),
  ).toEqual(["assets/picker.js", "assets/report.js", "assets/picker.css"]);
  // Pages list what they start with in full.
  expect(
    resolveDependencies("assets/index.js", ["assets/shared.js"], {
      hostId: "index.html",
      hostType: "html",
    }),
  ).toEqual(["assets/shared.js"]);
});
