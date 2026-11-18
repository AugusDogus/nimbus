import { expect, test } from "bun:test";
import { FilesystemFailure } from "./filesystem-failure";

const failure = (code: string) =>
  Object.assign(new Error(`${code}: failed, open '/srv/data/x'`), {
    code,
    syscall: "open",
  });

test("every mapped failure says what happened, that nothing changed and what to do next", () => {
  for (const code of [
    "ENOENT",
    "ENOTDIR",
    "EEXIST",
    "ENOTEMPTY",
    "EISDIR",
    "ENAMETOOLONG",
    "ELOOP",
    "EACCES",
    "EPERM",
    "EROFS",
    "ENOSPC",
    "EDQUOT",
    "EBUSY",
  ]) {
    const error = FilesystemFailure.toApiError(failure(code));
    if (!error) throw new Error(`${code} is not mapped.`);
    // Prefixed with the code, so a failure names the message that falls short.
    const said = `${code}: ${error.message}`;
    expect(said).toContain("Nothing was changed.");
    expect(said).toMatch(
      /(Refresh|Choose|Ask|ask|Try again|try again)[^.]*\.$/,
    );
    expect(error.message).not.toContain("/srv/data");
  }
});

test("a symbolic link names the way to reach what it points to", () => {
  const error = FilesystemFailure.toApiError(failure("ELOOP"));
  expect(error?.message).toContain("Symbolic links");
  expect(error?.message).toContain("mount");
});
