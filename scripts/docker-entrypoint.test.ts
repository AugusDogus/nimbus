import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(
  new URL("./docker-entrypoint.sh", import.meta.url),
);
let root: string;
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "nimbus-entrypoint-")),
  );
});
afterEach(async () => {
  // Files a namespace's mapped users own are removed from inside one first.
  if (mappedRoot)
    Bun.spawnSync([
      "unshare",
      "--map-auto",
      "--map-root-user",
      "rm",
      "-rf",
      root,
    ]);
  await rm(root, { recursive: true, force: true });
});

/** Run `script` with the entrypoint's functions defined. */
async function sh(script: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(["sh", "-c", `. "$0"; ${script}`, entrypoint], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      NIMBUS_ENTRYPOINT_FUNCTIONS: "1",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test.each([
  ["/data", "/config"],
  ["/data", "/data/.nimbus"],
  ["/data", "/data/.nimbus/state"],
  ["/data/", "/config/"],
  ["/srv/nimbus/data", "/srv/nimbus/config"],
])("accepts data root %s with config root %s", async (data, config) => {
  expect(await sh(`check_roots "${data}" "${config}" && echo ok`)).toEqual({
    code: 0,
    stdout: "ok\n",
    stderr: "",
  });
});

test.each([
  ["/data", "/data/Projects", "inside the data root"],
  ["/data", "/data", "inside the data root"],
  ["/data", "/data/x/../Projects", "inside the data root"],
  ["/data", "/data/.nimbusx", "inside the data root"],
  ["/data", "/", "NIMBUS_CONFIG_ROOT is /"],
  ["/", "/config", "NIMBUS_DATA_ROOT is /"],
  ["/srv/data", "/srv", "contains the data root"],
])(
  "refuses data root %s with config root %s before changing anything",
  async (data, config, reason) => {
    const result = await sh(`check_roots "${data}" "${config}" && echo ok`);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain("Nothing was changed");
  },
);

test("refuses empty roots and roots with control characters, which shells and Node read differently", async () => {
  for (const [data, config] of [
    ["", "/config"],
    ["/data", ""],
    ["/data\n", "/config"],
    ["/data", "/con\tfig"],
  ]) {
    const result = await sh('check_roots "$D" "$C" && echo ok', {
      D: data,
      C: config,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Nothing was changed");
  }
});

test("refuses a config root that reaches the data root through a symbolic link", async () => {
  await mkdir(path.join(root, "data/Projects"), { recursive: true });
  await symlink(path.join(root, "data/Projects"), path.join(root, "config"));
  const result = await sh(
    `check_roots "${root}/data" "${root}/config" && echo ok`,
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("inside the data root");
  // A config root linked to a separate directory is fine.
  await rm(path.join(root, "config"));
  await mkdir(path.join(root, "state"));
  await symlink(path.join(root, "state"), path.join(root, "config"));
  expect(
    (await sh(`check_roots "${root}/data" "${root}/config" && echo ok`)).stdout,
  ).toBe("ok\n");
});

test("a symbolic link in place of .nimbus is never followed", async () => {
  const data = path.join(root, "data");
  await mkdir(path.join(data, "Projects/versions/ab"), { recursive: true });
  await mkdir(path.join(data, "Projects/uploads"), { recursive: true });
  await writeFile(path.join(data, "Projects/uploads/a.bin"), "user file");
  await symlink(path.join(data, "Projects"), path.join(data, ".nimbus"));
  const { stdout } = await sh(
    `state_entries 4242 4242 "${root}/config" "${data}"`,
  );
  expect(stdout).toBe("");
});

test("startup re-owns only what Nimbus writes, never a user file or an inode it shares", async () => {
  const data = path.join(root, "data");
  const config = path.join(root, "config");
  const files: Record<string, string> = {
    "config/db.sqlite": "db",
    "config/db.sqlite-wal": "wal",
    "config/backups/nimbus-20260101T000000Z.sqlite": "backup",
    "config/cache/ab/thumb.webp": "thumb",
    "config/unrelated.txt": "not Nimbus's",
    "data/Projects/readme.txt": "user file",
    "data/users/bob/linked.txt": "finished upload",
    "data/.nimbus/uploads/partial.bin": "unfinished upload",
    // DATABASE_URL may keep a legacy database in .nimbus beside a separate config root.
    "data/.nimbus/db.sqlite": "legacy db",
    "data/.nimbus/db.sqlite-wal": "legacy wal",
    "data/.nimbus/trash/0001/old.txt": "trashed user file",
    "data/.nimbus/versions/ab/ab01": "saved version",
  };
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  // A finished upload keeps its staging name as a hardlink for a day.
  await link(
    path.join(data, "users/bob/linked.txt"),
    path.join(data, ".nimbus/uploads/finished.bin"),
  );
  await link(
    path.join(data, "Projects/readme.txt"),
    path.join(config, "cache/ab/planted.webp"),
  );
  await symlink(path.join(data, "Projects"), path.join(config, "cache/link"));
  // Owned by someone else, so everything Nimbus owns is listed.
  const { code, stdout } = await sh(
    `state_entries 4242 4242 "${config}" "${data}"`,
  );
  expect(code).toBe(0);
  const listed = stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => path.relative(root, entry))
    .sort();
  expect(listed).toEqual(
    [
      "config",
      "config/backups",
      "config/backups/nimbus-20260101T000000Z.sqlite",
      "config/cache",
      "config/cache/ab",
      "config/cache/ab/thumb.webp",
      "config/db.sqlite",
      "config/db.sqlite-wal",
      "data/.nimbus",
      "data/.nimbus/db.sqlite",
      "data/.nimbus/db.sqlite-wal",
      "data/.nimbus/trash",
      "data/.nimbus/uploads",
      "data/.nimbus/uploads/partial.bin",
      "data/.nimbus/versions",
      "data/.nimbus/versions/ab",
    ].sort(),
  );
  // Entries already owned by the target user are skipped.
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  expect(
    await sh(`state_entries ${uid} ${gid} "${config}" "${data}" | wc -c`),
  ).toMatchObject({ code: 0, stdout: "0\n" });
});

/** Whether this machine gives an unprivileged user a namespace with many mapped ids. */
const mappedRoot =
  Bun.spawnSync(["unshare", "--map-auto", "--map-root-user", "true"])
    .exitCode === 0;

/** Run `script` as root in a user namespace with mapped ids, the entrypoint's functions defined. */
async function asRoot(script: string) {
  const child = Bun.spawn(
    [
      "unshare",
      "--map-auto",
      "--map-root-user",
      "sh",
      "-c",
      `. "$0"; ${script}`,
      entrypoint,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", NIMBUS_ENTRYPOINT_FUNCTIONS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const layout =
  'stat -c "%u:%g:%a" "$config" "$config/supervisor" "$config/supervisor/releases" "$config/server.lock"';

test.skipIf(!mappedRoot)(
  "the split is prepared once: a sticky config root, the supervisor's own folder and lock, logged when it changes",
  async () => {
    const script = `config="${root}/config"; mkdir -p "$config"; chown 2000:2000 "$config"; prepare_split "$config" 2000 2000 1100; ${layout}`;
    const first = await asRoot(script);
    expect(first.code).toBe(0);
    expect(first.stdout.trim().split("\n")).toEqual([
      "0:2000:1771",
      "1100:1100:755",
      "1100:1100:755",
      "1100:2000:660",
    ]);
    expect(first.stderr).toContain("1771");
    const again = await asRoot(
      `config="${root}/config"; prepare_split "$config" 2000 2000 1100; ${layout}`,
    );
    expect(again.stdout).toBe(first.stdout);
    expect(again.stderr).toBe("");
  },
);

test.skipIf(!mappedRoot)(
  "a supervisor folder the servers' user made, or a link in its place, is set aside and never trusted",
  async () => {
    for (const plant of [
      'ln -s /etc "$config/supervisor"',
      'mkdir -p "$config/supervisor/releases/edge-9-aaaaaaaaaaaa" && chown -R 2000:2000 "$config/supervisor"',
    ]) {
      const done = await asRoot(
        `config="${root}/config-$$"; mkdir -p "$config"; chown 2000:2000 "$config"; ${plant}; prepare_split "$config" 2000 2000 1100; ${layout}; ls "$config/supervisor/releases" | wc -l; ls "$config" | grep -c "supervisor.untrusted"`,
      );
      expect(done.code).toBe(0);
      const lines = done.stdout.trim().split("\n");
      expect(lines[1]).toBe("1100:1100:755");
      expect(lines[4]).toBe("0");
      expect(lines[5]).toBe("1");
      expect(done.stderr).toContain("aside as");
    }
  },
);

const startAs = (prefix: string) =>
  asRoot(
    `export NIMBUS_DATA_ROOT="${root}/data" NIMBUS_CONFIG_ROOT="${root}/config" PUID=2000 PGID=2000; ${prefix} sh -c '. "$0"; main sh -c "id -u; grep ^CapEff /proc/self/status"' "$0"`,
  );

test.skipIf(!mappedRoot)(
  "started as root, the command runs as the supervisor's user with the rights to start and stop servers",
  async () => {
    const started = await startAs("");
    expect(started.code).toBe(0);
    expect(started.stdout.split("\n").slice(0, 2)).toEqual([
      "1100",
      "CapEff:\t00000000000000e0",
    ]);
  },
);

test.skipIf(!mappedRoot)(
  "without the right to limit capabilities, as under a cap_drop, it still starts, as one user, and says updates are off",
  async () => {
    const started = await startAs("setpriv --bounding-set=-setpcap --");
    expect(started.code).toBe(0);
    expect(started.stdout.split("\n").slice(0, 2)).toEqual([
      "2000",
      "CapEff:\t0000000000000000",
    ]);
    expect(started.stderr).toContain("In-app updates are off");
    // The config root is the servers' again, so they can write it.
    expect((await asRoot(`stat -c %u:%g "${root}/config"`)).stdout.trim()).toBe(
      "2000:2000",
    );
  },
);
