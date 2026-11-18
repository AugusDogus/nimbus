// Preloaded by `bun test` (see bunfig.toml). Fails the run when a test touches state outside its
// own temporary directories:
//
// - Importing the server's configured database (apps/web/server/db/index.ts) opens or creates
//   the real database on import, at ./data/.nimbus/db.sqlite when nothing is configured. Tests
//   use createTestDatabase from apps/web/server/db/testing.ts or openDatabase from
//   ./connection instead, and import other modules that need a store through a seam that does
//   not import the singleton.
// - Any file or folder that appears in the repository during the run fails it, with its path.
import { afterAll, mock } from "bun:test";
import path from "node:path";

const repository = path.resolve(import.meta.dir, "..");

await mock.module(path.join(repository, "apps/web/server/db/index.ts"), () => {
  throw new Error(
    "A test imported apps/web/server/db/index.ts, which opens the server's configured database (./data/.nimbus/db.sqlite by default) in the repository. The test file was stopped before it ran. Use createTestDatabase from apps/web/server/db/testing.ts, or move the code under test out of the module that imports the database.",
  );
});

/** Untracked and ignored paths, with directories git does not descend into collapsed. */
function untracked() {
  const status = Bun.spawnSync(
    ["git", "status", "--porcelain=v1", "-z", "--ignored=matching"],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  if (status.exitCode !== 0)
    throw new Error(
      `The test guard could not list untracked files with git status in ${repository} (exit ${status.exitCode}): ${status.stderr.toString().trim()}. Tests ran, but whether they left files in the repository was not checked. Run bun test inside the git checkout.`,
    );
  return new Set(
    status.stdout
      .toString()
      .split("\0")
      .filter((entry) => entry.startsWith("?? ") || entry.startsWith("!! "))
      .map((entry) => entry.slice(3)),
  );
}

const before = untracked();

afterAll(() => {
  const left = [...untracked()].filter((entry) => !before.has(entry));
  if (left.length > 0)
    throw new Error(
      `Tests left files in the repository: ${left.join(", ")}. Create test files under os.tmpdir() and remove them after the test. Delete these paths before the next run.`,
    );
});
