import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
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

const layout = 'stat -c "%u:%g:%a" "$store" "$store/releases" "$store/staging"';

test.skipIf(!mappedRoot)(
  "a fresh store gets the image's layout once, and one laid out otherwise is left as it is",
  async () => {
    const first = await asRoot(
      `store="${root}/store"; prepare_store "$store" 1100; ${layout}`,
    );
    expect(first.code).toBe(0);
    expect(first.stdout.trim().split("\n")).toEqual([
      "0:0:755",
      "0:0:755",
      "1100:0:750",
    ]);
    // A bind mount someone else owns: only the store folder itself becomes root's.
    const mounted = await asRoot(
      `store="${root}/mounted"; mkdir -p "$store/staging"; chown -R 2000:2000 "$store"; prepare_store "$store" 1100; ${layout}`,
    );
    expect(mounted.stdout.trim().split("\n")).toEqual([
      "0:0:755",
      "0:0:755",
      "2000:2000:755",
    ]);
    // A link is never followed.
    const linked = await asRoot(
      `mkdir "${root}/elsewhere"; ln -s "${root}/elsewhere" "${root}/linked"; prepare_store "${root}/linked" 1100; ls "${root}/elsewhere" | wc -l`,
    );
    expect(linked.stdout.trim()).toBe("0");
    expect(linked.stderr).toContain("is a link");
  },
);

/** Start the entrypoint as root of a namespace, `prefix` before it, with a probe as the command. */
async function startAs(prefix: string) {
  await Bun.write(
    path.join(root, "probe.sh"),
    'id -u; id -G; grep -E "^(CapEff|CapBnd|NoNewPrivs):" /proc/self/status; env | grep ^NIMBUS_SERVER_ | sort\n',
  );
  // Readable by the servers' user, as the one-user start runs it as them.
  await chmod(root, 0o755);
  return asRoot(
    `export NIMBUS_DATA_ROOT="${root}/data" NIMBUS_CONFIG_ROOT="${root}/config" NIMBUS_TEST_STORE_DIR="${root}/store" PUID=2000 PGID=2000; ${prefix} sh -c '. "$0"; main sh "$1"' "$0" "${root}/probe.sh"`,
  );
}

test.skipIf(!mappedRoot)(
  "started as root, the supervisor stays root with only the capabilities its job needs, told the servers' ids",
  async () => {
    const started = await startAs("");
    expect(started.code).toBe(0);
    expect(started.stdout.trim().split("\n")).toEqual([
      "0",
      "0",
      "CapEff:\t00000000000001e0",
      "CapBnd:\t00000000000001e0",
      "NoNewPrivs:\t1",
      "NIMBUS_SERVER_GID=2000",
      "NIMBUS_SERVER_UID=2000",
    ]);
    // The config root is the servers' as on any start; nothing else of it changed.
    expect(
      (await asRoot(`stat -c %u:%g:%a "${root}/config"`)).stdout.trim(),
    ).toBe("2000:2000:755");
  },
);

test.skipIf(!mappedRoot)(
  "without the right to limit capabilities, as under a cap_drop, it still starts, as one user, and says updates are off",
  async () => {
    const started = await startAs("setpriv --bounding-set=-setpcap --");
    expect(started.code).toBe(0);
    expect(started.stdout.split("\n")[0]).toBe("2000");
    expect(started.stderr).toContain("In-app updates are off");
  },
);

test.skipIf(!mappedRoot)(
  "without the rights to switch users it changes nothing and says to start with --user",
  async () => {
    const started = await startAs("setpriv --bounding-set=-setuid --");
    expect(started.code).not.toBe(0);
    expect(started.stderr).toContain("--user");
    expect(started.stderr.trim().split("\n")).toHaveLength(1);
    // Decided before anything was touched: no root, store or ownership was made or changed.
    expect(
      (await asRoot(`ls -A "${root}"`)).stdout.trim().split("\n").sort(),
    ).toEqual(["probe.sh"]);
  },
);

test.skipIf(!mappedRoot)(
  "only the data and config roots themselves become PUID:PGID's, never what is in them",
  async () => {
    const prepared = await asRoot(
      `mkdir -p "${root}/data/films" "${root}/config/backups"; touch "${root}/data/films/film.mkv" "${root}/config/db.sqlite"; chown -R 3000:3000 "${root}/data" "${root}/config"`,
    );
    expect(prepared.code).toBe(0);
    expect((await startAs("")).code).toBe(0);
    const owners = await asRoot(
      `stat -c %u:%g "${root}/data" "${root}/config" "${root}/data/films" "${root}/data/films/film.mkv" "${root}/config/db.sqlite" "${root}/config/backups"`,
    );
    expect(owners.stdout.trim().split("\n")).toEqual([
      "2000:2000",
      "2000:2000",
      "3000:3000",
      "3000:3000",
      "3000:3000",
      "3000:3000",
    ]);
  },
);

test.skipIf(!mappedRoot)(
  "a root under a folder the servers' user could change is left as it is, and said so",
  async () => {
    // The config root inside the data root's .nimbus, which the servers' user owns: a link
    // swapped in there could lead a chown anywhere.
    await asRoot(
      `mkdir -p "${root}/data/.nimbus/config"; chown 2000:2000 "${root}/data" "${root}/data/.nimbus"; chown 3000:3000 "${root}/data/.nimbus/config"`,
    );
    const started = await asRoot(
      `export NIMBUS_DATA_ROOT="${root}/data" NIMBUS_CONFIG_ROOT="${root}/data/.nimbus/config" NIMBUS_TEST_STORE_DIR="${root}/store" PUID=2000 PGID=2000; sh -c '. "$0"; main true' "$0"`,
    );
    expect(started.stderr).toContain("left the owner");
    expect(
      (
        await asRoot(`stat -c %u:%g "${root}/data/.nimbus/config"`)
      ).stdout.trim(),
    ).toBe("3000:3000");
  },
);

test.skipIf(!mappedRoot)(
  "the test store is honoured only from a source checkout",
  async () => {
    // The entrypoint as an image has it: no .git above it.
    await mkdir(path.join(root, "image/bin"), { recursive: true });
    const copy = path.join(root, "image/bin/nimbus-entrypoint");
    await Bun.write(copy, await Bun.file(entrypoint).text());
    const started = await asRoot(
      `export NIMBUS_DATA_ROOT="${root}/data" NIMBUS_CONFIG_ROOT="${root}/config" NIMBUS_TEST_STORE_DIR="${root}/store" PUID=2000 PGID=2000; sh -c '. "$0"; main true' "${copy}"`,
    );
    expect(started.code).toBe(0);
    expect(await Bun.file(path.join(root, "store/releases")).exists()).toBe(
      false,
    );
    expect((await asRoot(`ls -d "${root}/store" 2>&1`)).code).not.toBe(0);
  },
);

test.skipIf(!mappedRoot)(
  "the root supervisor starts with nothing that changes what Bun loads, a home only root may write, and absolute commands",
  async () => {
    await chmod(root, 0o755);
    await Bun.write(
      path.join(root, "env.sh"),
      'env | grep -E "^(HOME|TMPDIR|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|BUN_[A-Z_]*|XDG_CONFIG_HOME|PATH)=" | sort\n',
    );
    const started = await asRoot(
      `export NIMBUS_DATA_ROOT="${root}/data" NIMBUS_CONFIG_ROOT="${root}/config" PUID=2000 PGID=2000 HOME=/tmp TMPDIR=/tmp NODE_OPTIONS=--require=/tmp/evil.js NODE_PATH=/tmp LD_PRELOAD=/tmp/evil.so BUN_CONFIG_REGISTRY=http://evil.test XDG_CONFIG_HOME=/tmp PATH="/tmp:$PATH"; sh -c '. "$0"; main sh "$1"' "$0" "${root}/env.sh"`,
    );
    expect(started.code).toBe(0);
    expect(started.stdout.trim().split("\n")).toEqual([
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
      "HOME=/root",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]);
  },
);
