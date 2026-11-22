import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ServerChild } from "./server-child-testing";

/**
 * The real server started on a data root like a shared NAS folder: folders and files it may
 * not read, one made unreadable while it runs, broken, looping and escaping symlinks, a FIFO,
 * a socket, names that are not UTF-8 or hold a newline, a path longer than the system allows
 * and a large folder. Its first deployment to such a tree crashed in a loop on the first
 * unreadable folder the watcher met. Device nodes and nested mounts need privileges, so they
 * are not made here (nested-mount.test.ts covers mounts).
 */
const asRoot = process.getuid?.() === 0;
const rootSkip = "running as root, where folder permissions do not apply";
if (asRoot) console.warn(`Skipping the hostile data root test: ${rootSkip}.`);

// On disk: /tmp is often a RAM-backed tmpfs.
const scratch = existsSync("/var/tmp") ? "/var/tmp" : os.tmpdir();
let workspace: string;
let data: string;
/** Folders and files made unreadable, opened again before cleanup. */
const locked: string[] = [];
let socket: ReturnType<typeof Bun.listen> | null = null;
/** Why this system could not make the path longer than PATH_MAX, or null when it could. */
let noDeepPath: string | null = null;

/**
 * Make `levels` nested folders named `name` in `root`, and a file at the bottom, through open
 * descriptors: a path past PATH_MAX cannot be named whole, and shells and runtimes that track
 * the working directory (dash's cd, Bun's chdir) refuse to go below it.
 */
function makeDeepPath(root: string, name: string, levels: number) {
  let folder = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (let level = 0; level < levels; level++) {
      const child = `/proc/self/fd/${folder}/${name}`;
      mkdirSync(child);
      const opened = openSync(
        child,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      closeSync(folder);
      folder = opened;
    }
    writeFileSync(`/proc/self/fd/${folder}/deep.txt`, "deep");
  } finally {
    closeSync(folder);
  }
}

async function lock(target: string, mode: number) {
  await chmod(target, mode);
  locked.push(target);
}

beforeAll(async () => {
  if (asRoot) return;
  workspace = await mkdtemp(path.join(scratch, "nimbus-hostile-"));
  data = path.join(workspace, "data");
  await mkdir(path.join(data, "open"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt"])
    await writeFile(path.join(data, "open", name), name);
  // Another program's private folders, as another container's 750 folder is to Nimbus.
  await mkdir(path.join(data, "other-app/wal"), { recursive: true });
  await writeFile(path.join(data, "other-app/wal/segment"), "x");
  await lock(path.join(data, "other-app/wal"), 0);
  await mkdir(path.join(data, "search-only"));
  await lock(path.join(data, "search-only"), 0o111);
  await writeFile(path.join(data, "open/private.txt"), "x");
  await lock(path.join(data, "open/private.txt"), 0);
  await symlink("missing", path.join(data, "open/broken-link"));
  await symlink("loop-b", path.join(data, "open/loop-a"));
  await symlink("loop-a", path.join(data, "open/loop-b"));
  await symlink("..", path.join(data, "open/up"));
  await symlink(workspace, path.join(data, "open/outside"));
  expect(Bun.spawnSync(["mkfifo", path.join(data, "open/fifo")]).exitCode).toBe(
    0,
  );
  socket = Bun.listen({
    unix: path.join(data, "open/socket"),
    socket: { data() {} },
  });
  const notUtf8 = Buffer.concat([
    Buffer.from(path.join(data, "not-utf8-")),
    Buffer.from([0xff, 0xfe]),
  ]);
  mkdirSync(notUtf8);
  writeFileSync(
    Buffer.concat([
      notUtf8,
      Buffer.from("/inside-"),
      Buffer.from([0xc3, 0x28]),
    ]),
    "x",
  );
  await mkdir(path.join(data, "new\nline"));
  await writeFile(path.join(data, "new\nline/file.txt"), "x");
  // Deeper than PATH_MAX (4096 bytes): 25 folders of 200 characters.
  try {
    makeDeepPath(data, "l".repeat(200), 25);
  } catch (error) {
    noDeepPath = `this system cannot make a path longer than PATH_MAX through /proc/self/fd (${error instanceof Error ? error.message : String(error)})`;
    console.warn(
      `The hostile data root test runs without its over-long path: ${noDeepPath}.`,
    );
  }
  await mkdir(path.join(data, "large"));
  for (let index = 0; index < 20_000; index++)
    writeFileSync(path.join(data, "large", `entry-${index}`), "");
  await mkdir(path.join(workspace, "config"));
});

afterAll(async () => {
  if (asRoot) return;
  socket?.stop(true);
  for (const target of locked) await chmod(target, 0o755).catch(() => {});
  await rm(workspace, { recursive: true, force: true });
});

test.skipIf(asRoot)(
  `the server starts, stays up and follows changes on a data root with hostile entries${asRoot ? ` (skipped: ${rootSkip})` : ""}`,
  async () => {
    // Not the address it listens on: requests name it as the page's origin.
    const origin = "http://nimbus.example.test";
    await ServerChild.run(
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "",
          // Development serves pages from Vite, which this test never asks for; the API,
          // watcher and search are the same as in production.
          NODE_ENV: "development",
          NIMBUS_VITE_ORIGIN: "http://127.0.0.1:9",
          BETTER_AUTH_URL: origin,
          BETTER_AUTH_SECRET: "hostile-tree-secret-hostile-tree-secret-0",
          NIMBUS_DATA_ROOT: data,
          NIMBUS_CONFIG_ROOT: path.join(workspace, "config"),
          NIMBUS_WATCH_DEBOUNCE_MS: "50",
          NIMBUS_RECONCILE_INTERVAL_MS: "2000",
        },
      },
      async (server) => {
        const health = () =>
          fetch(`${server.url}/api/health`).then((response) => response.status);
        expect(await health()).toBe(200);

        const signup = await fetch(`${server.url}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({
            name: "Admin",
            email: "admin@hostile.test",
            password: "Hostile-tree-42",
          }),
        });
        expect(signup.status).toBe(200);
        const cookie = signup.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const query = async (procedure: string, input: unknown) => {
          const response = await fetch(
            `${server.url}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`,
            { headers: { Cookie: cookie, Origin: origin } },
          );
          return { status: response.status, text: await response.text() };
        };
        const search = (name: string) =>
          query("catalog.search", { query: name }).then(({ text }) => text);

        // Changes made outside Nimbus next to the hostile entries, and a folder made
        // unreadable while the server runs.
        await mkdir(path.join(data, "open/late"), { mode: 0 });
        locked.push(path.join(data, "open/late"));
        await writeFile(path.join(data, "open/fresh-note.txt"), "new");
        await rename(
          path.join(data, "open/a.txt"),
          path.join(data, "open/renamed-note.txt"),
        );
        await unlink(path.join(data, "open/b.txt"));

        await server.until(
          async () =>
            (await search("fresh-note")).includes("fresh-note.txt") &&
            (await search("renamed-note")).includes("renamed-note.txt"),
          "search to find the new and renamed files",
        );
        expect(await search("b.txt")).not.toContain('"b.txt"');
        const listing = await query("files.list", { path: "open" });
        expect(listing.status).toBe(200);
        expect(listing.text).toContain("fresh-note.txt");
        expect(listing.text).toContain("renamed-note.txt");
        expect(listing.text).not.toContain('"a.txt"');
        expect(listing.text).not.toContain('"b.txt"');

        // At least one reconciliation pass over the whole tree, after those changes.
        const passes = () => server.output().split("(reconcile)").length - 1;
        const before = passes();
        await server.until(() => passes() > before, "a reconciliation pass");
        // A file made only now, found by the watcher or the pass.
        await writeFile(path.join(data, "open/after-pass.txt"), "x");
        await server.until(
          async () => (await search("after-pass")).includes("after-pass.txt"),
          "search to find a file made after the pass",
        );

        expect(server.running()).toBe(true);
        expect(await health()).toBe(200);
        const output = server.output();
        // Each folder the watcher cannot read or reach is reported once, without a stack, though
        // Bun names only the first one its initial walk meets: the crawl names the others.
        for (const folder of ["other-app/wal", "search-only", "open/late"])
          expect(
            output.split(`folder ${path.join(data, folder)} `).length - 1,
          ).toBe(1);
        if (noDeepPath === null) expect(output).toContain("ENAMETOOLONG");
        expect(output).not.toMatch(/\n\s+at .*watch/);
        expect(output).not.toContain("Unhandled");
      },
    );
  },
  120_000,
);
