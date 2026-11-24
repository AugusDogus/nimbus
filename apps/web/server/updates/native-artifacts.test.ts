import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeArtifacts } from "./native-artifacts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nimbus-natives-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytes = (...values: number[]) => new Uint8Array(values);
/** A PE file: "MZ", its header's offset at 0x3c, and "PE\0\0" there. */
function portableExecutable() {
  const file = new Uint8Array(0x50);
  file.set([0x4d, 0x5a]);
  file.set([0x40, 0, 0, 0], 0x3c);
  file.set([0x50, 0x45, 0, 0], 0x40);
  return file;
}

test("native binaries are found by their headers, whatever they are named", async () => {
  await mkdir(path.join(root, "node_modules/pkg/bin"), { recursive: true });
  const files: [string, Uint8Array][] = [
    ["node_modules/pkg/addon.node", bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1)],
    ["node_modules/pkg/helper.js", bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1)],
    ["node_modules/pkg/bin/tool", bytes(0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1)],
    ["node_modules/pkg/bin/tool32", bytes(0xce, 0xfa, 0xed, 0xfe, 7, 0, 0, 0)],
    ["node_modules/pkg/universal", bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2)],
    ["node_modules/pkg/tool.txt", portableExecutable()],
  ];
  for (const [name, content] of files)
    await writeFile(path.join(root, name), content);
  // Not native: text, a script, WebAssembly, a Java class, a short or empty file, "MZ" text.
  const portable: [string, Uint8Array | string][] = [
    ["node_modules/pkg/index.js", "module.exports = 1;\n"],
    ["node_modules/pkg/run.sh", "#!/bin/sh\necho hi\n"],
    ["node_modules/pkg/code.wasm", bytes(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0)],
    ["node_modules/pkg/Main.class", bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52)],
    ["node_modules/pkg/short", bytes(0x7f, 0x45)],
    ["node_modules/pkg/empty", bytes()],
    ["node_modules/pkg/README.md", "MZ is a letter pair, and nothing more.\n"],
  ];
  for (const [name, content] of portable)
    await writeFile(path.join(root, name), content);
  // A link is not followed, even to a native binary.
  await symlink("addon.node", path.join(root, "node_modules/pkg/linked"));
  expect(await NativeArtifacts.find(root)).toEqual(
    files.map(([name]) => name).sort(),
  );
});
