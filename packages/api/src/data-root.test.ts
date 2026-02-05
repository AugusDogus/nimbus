import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getDataRoot } from "./data-root";

describe("getDataRoot", () => {
  let previousRoot: string | undefined;

  beforeEach(() => {
    previousRoot = process.env.NIMBUS_DATA_ROOT;
  });

  afterEach(() => {
    process.env.NIMBUS_DATA_ROOT = previousRoot;
  });

  it("normalizes MSYS paths on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    process.env.NIMBUS_DATA_ROOT = "/c/Users/Alice/Downloads";
    const resolved = getDataRoot();
    expect(resolved).toBe("C:\\Users\\Alice\\Downloads");
  });
});
