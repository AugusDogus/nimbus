import { expect, it } from "bun:test";
import { DriveRoot } from "./drive-root";

it("names a folder by its last segment, and the drive root Files", () => {
  expect(DriveRoot.nameOf("")).toBe("Files");
  expect(DriveRoot.nameOf("users/ann/Trip 100%")).toBe("Trip 100%");
});
