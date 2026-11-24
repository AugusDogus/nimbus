import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BundleArchive } from "./bundle-archive";

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "nimbus-archive-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const deep = `node_modules/.bun/${"package-with-a-long-name".repeat(4)}@1.0.0/node_modules/package/index.js`;

async function tree() {
  const root = path.join(scratch, "tree");
  await mkdir(path.join(root, "apps/web/server"), { recursive: true });
  await writeFile(
    path.join(root, "apps/web/server/start.ts"),
    "console.log(1);\n",
  );
  await writeFile(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(path.dirname(path.join(root, deep)), { recursive: true });
  await writeFile(path.join(root, deep), "module.exports = 1;\n");
  await mkdir(path.join(root, "apps/web/node_modules"), { recursive: true });
  await symlink(
    `../../../${path.dirname(deep)}`,
    path.join(root, "apps/web/node_modules/package"),
  );
  await mkdir(path.join(root, "empty"));
  return root;
}

const unpackFile = async (file: string, into: string) => {
  await mkdir(into, { recursive: true });
  return BundleArchive.unpack(Bun.file(file).stream(), into);
};

test("a tree round-trips with its folders, executable bit, long names and links inside it", async () => {
  const root = await tree();
  const archive = path.join(scratch, "bundle.tar.gz");
  const written = await BundleArchive.write(root, archive);
  expect(written).toEqual(await BundleArchive.digest(archive));
  const into = path.join(scratch, "into");
  const unpacked = await unpackFile(archive, into);
  expect(unpacked.ok).toBe(true);
  expect(await readFile(path.join(into, deep), "utf8")).toBe(
    "module.exports = 1;\n",
  );
  expect((await stat(path.join(into, "run.sh"))).mode & 0o777).toBe(0o755);
  expect(
    (await stat(path.join(into, "apps/web/server/start.ts"))).mode & 0o777,
  ).toBe(0o644);
  expect(await readlink(path.join(into, "apps/web/node_modules/package"))).toBe(
    `../../../${path.dirname(deep)}`,
  );
  expect((await lstat(path.join(into, "empty"))).isDirectory()).toBe(true);
  // The same tree always gives the same bytes.
  const again = path.join(scratch, "again.tar.gz");
  expect((await BundleArchive.write(root, again)).sha256).toBe(written.sha256);
});

test("GNU tar reads what it writes, and it reads what GNU tar writes", async () => {
  const root = await tree();
  const archive = path.join(scratch, "bundle.tar.gz");
  await BundleArchive.write(root, archive);
  const listed = Bun.spawnSync(["tar", "-tzf", archive]);
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout.toString()).toContain(deep);
  const gnu = path.join(scratch, "gnu.tar.gz");
  expect(
    Bun.spawnSync(["tar", "--format=pax", "-czf", gnu, "-C", root, "."])
      .exitCode,
  ).toBe(0);
  const into = path.join(scratch, "from-gnu");
  expect((await unpackFile(gnu, into)).ok).toBe(false);
  // GNU tar names entries "./…", which a release never does; without that prefix it is read.
  const plain = path.join(scratch, "plain.tar.gz");
  expect(
    Bun.spawnSync([
      "sh",
      "-c",
      `cd '${root}' && tar --format=pax -czf '${plain}' apps run.sh node_modules empty`,
    ]).exitCode,
  ).toBe(0);
  const fromPlain = path.join(scratch, "from-plain");
  expect((await unpackFile(plain, fromPlain)).ok).toBe(true);
  expect(await readFile(path.join(fromPlain, deep), "utf8")).toBe(
    "module.exports = 1;\n",
  );
});

/** An archive GNU tar makes from `files` in `cwd`, with extra flags. */
function gnuArchive(cwd: string, files: string[], flags: string[] = []) {
  const file = path.join(
    scratch,
    `crafted-${Math.random().toString(36).slice(2)}.tar.gz`,
  );
  const made = Bun.spawnSync(
    ["tar", "--format=pax", ...flags, "-czf", file, ...files],
    {
      cwd,
    },
  );
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return file;
}

test("entries outside the release, links leading out of it and other kinds of entry are refused", async () => {
  const work = path.join(scratch, "work/inner");
  await mkdir(work, { recursive: true });
  await writeFile(path.join(scratch, "work/outside.txt"), "outside");
  await writeFile(path.join(work, "file.txt"), "inside");
  await symlink("../../etc", path.join(work, "escape"));
  await link(path.join(work, "file.txt"), path.join(work, "hard.txt"));
  const cases: [string, string][] = [
    [
      gnuArchive(work, ["file.txt"], ["-P", "--transform=s,^,../,"]),
      "outside a release",
    ],
    [
      gnuArchive(
        work,
        [path.join(scratch, "work/outside.txt")],
        ["--absolute-names"],
      ),
      "outside a release",
    ],
    [gnuArchive(work, ["escape"]), "leads outside the release"],
    [gnuArchive(work, ["file.txt", "hard.txt"]), "entry type"],
  ];
  for (const [archive, message] of cases) {
    const into = path.join(
      scratch,
      `into-${Math.random().toString(36).slice(2)}`,
    );
    const unpacked = await unpackFile(archive, into);
    expect(unpacked.ok).toBe(false);
    if (!unpacked.ok) expect(unpacked.error.message).toContain(message);
  }
});

test("a file written through a link inside the release is refused", async () => {
  const work = path.join(scratch, "via");
  await mkdir(path.join(work, "real"), { recursive: true });
  await symlink("real", path.join(work, "alias"));
  await mkdir(path.join(scratch, "via-second/alias"), { recursive: true });
  await writeFile(path.join(scratch, "via-second/alias/x.txt"), "through");
  const first = gnuArchive(work, ["alias"]);
  const second = gnuArchive(path.join(scratch, "via-second"), ["alias/x.txt"]);
  // One archive holding the link, then a file below it.
  const joined = path.join(scratch, "joined.tar.gz");
  const tarA = Bun.gunzipSync(
    new Uint8Array(await Bun.file(first).arrayBuffer()),
  );
  const tarB = Bun.gunzipSync(
    new Uint8Array(await Bun.file(second).arrayBuffer()),
  );
  const withoutEnd = (bytes: Uint8Array) => {
    let end = bytes.byteLength;
    while (
      end >= 512 &&
      bytes.subarray(end - 512, end).every((byte) => byte === 0)
    )
      end -= 512;
    return bytes.subarray(0, end);
  };
  const a = withoutEnd(tarA);
  const combined = new Uint8Array(a.byteLength + tarB.byteLength);
  combined.set(a);
  combined.set(tarB, a.byteLength);
  await Bun.write(joined, Bun.gzipSync(combined));
  const unpacked = await unpackFile(joined, path.join(scratch, "joined-into"));
  expect(unpacked.ok).toBe(false);
  if (!unpacked.ok)
    expect(unpacked.error.message).toContain("through a symbolic link");
});

test("a cut-off archive is refused", async () => {
  const root = await tree();
  const archive = path.join(scratch, "bundle.tar.gz");
  await BundleArchive.write(root, archive);
  const tar = Bun.gunzipSync(
    new Uint8Array(await Bun.file(archive).arrayBuffer()),
  );
  const cut = path.join(scratch, "cut.tar.gz");
  await Bun.write(cut, Bun.gzipSync(tar.subarray(0, 700)));
  const unpacked = await unpackFile(cut, path.join(scratch, "cut-into"));
  expect(unpacked.ok).toBe(false);
});

test("a link that leads out only through another link is refused once the tree is complete", async () => {
  const work = path.join(scratch, "chain");
  await mkdir(path.join(work, "a/b"), { recursive: true });
  // Each target stays inside when read as text; followed, `s` is `a`, and three levels up from it
  // is outside.
  await symlink("..", path.join(work, "a/b/s"));
  await symlink("s/../../..", path.join(work, "a/b/T"));
  const archive = gnuArchive(work, ["a"]);
  const into = path.join(scratch, "chain-into");
  const unpacked = await unpackFile(archive, into);
  expect(unpacked.ok).toBe(false);
  if (!unpacked.ok)
    expect(unpacked.error.message).toContain("leads outside the release");
});

test("PAX headers count toward the entry limit, and deep paths and huge PAX records are refused", async () => {
  const work = path.join(scratch, "limits");
  const long = "n".repeat(120);
  await mkdir(path.join(work, "d"), { recursive: true });
  for (const index of [1, 2, 3])
    await writeFile(path.join(work, "d", `${long}-${index}`), "x");
  const archive = gnuArchive(work, ["d"]);
  const capped = await BundleArchive.unpack(
    Bun.file(archive).stream(),
    await fresh("capped"),
    {
      maxEntries: 5,
    },
  );
  expect(capped.ok).toBe(false);
  if (!capped.ok) expect(capped.error.message).toContain("more entries");
  const deep = path.join(scratch, "deep");
  const parts = Array.from({ length: 140 }, (_, index) => `${index}`);
  await mkdir(path.join(deep, ...parts), { recursive: true });
  const deepArchive = gnuArchive(deep, ["0"]);
  const tooDeep = await BundleArchive.unpack(
    Bun.file(deepArchive).stream(),
    await fresh("deep"),
  );
  expect(tooDeep.ok).toBe(false);
  if (!tooDeep.ok) expect(tooDeep.error.message).toContain("deeper");
  const huge = path.join(scratch, "huge");
  await mkdir(huge);
  await writeFile(path.join(huge, "f"), "x");
  const hugeArchive = gnuArchive(
    huge,
    ["f"],
    [`--pax-option=comment:=${"c".repeat(80_000)}`],
  );
  const paxTooLarge = await BundleArchive.unpack(
    Bun.file(hugeArchive).stream(),
    await fresh("huge"),
  );
  expect(paxTooLarge.ok).toBe(false);
  if (!paxTooLarge.ok) expect(paxTooLarge.error.message).toContain("PAX");
});

test("a large file comes out whole", async () => {
  const work = path.join(scratch, "large");
  await mkdir(work);
  const content = new Uint8Array(24 * 1024 * 1024);
  for (let index = 0; index < content.byteLength; index += 4096)
    content[index] = index % 251;
  await writeFile(path.join(work, "large.bin"), content);
  const archive = path.join(scratch, "large.tar.gz");
  await BundleArchive.write(work, archive);
  const into = await fresh("large-into");
  expect(
    (await BundleArchive.unpack(Bun.file(archive).stream(), into)).ok,
  ).toBe(true);
  const back = new Uint8Array(
    await Bun.file(path.join(into, "large.bin")).arrayBuffer(),
  );
  expect(back.byteLength).toBe(content.byteLength);
  expect(Buffer.compare(back, content)).toBe(0);
});

async function fresh(name: string) {
  const folder = path.join(
    scratch,
    `${name}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(folder);
  return folder;
}
