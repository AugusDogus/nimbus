import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ControlSocket } from "./control-socket";

let directory: string;
let socket: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "nimbus-control-"));
  socket = path.join(directory, "private", "control.sock");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("makes a private directory for a new socket", async () => {
  expect(await ControlSocket.prepare(socket)).toEqual({
    ok: true,
    value: undefined,
  });
});

test("never deletes a file that is not a socket, such as a database", async () => {
  await mkdir(path.dirname(socket), { mode: 0o700 });
  await writeFile(socket, "precious");
  const prepared = await ControlSocket.prepare(socket);
  expect(prepared.ok).toBe(false);
  if (!prepared.ok) expect(prepared.error.message).toContain("is not a socket");
  expect(await readFile(socket, "utf8")).toBe("precious");
});

test("refuses a socket another supervisor still answers on", async () => {
  await mkdir(path.dirname(socket), { mode: 0o700 });
  const live = Bun.serve({ unix: socket, fetch: () => new Response("status") });
  try {
    const prepared = await ControlSocket.prepare(socket);
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.error.message).toContain("answers");
    expect(existsSync(socket)).toBe(true);
  } finally {
    await live.stop(true);
  }
});

test("removes a socket nothing answers on any more", async () => {
  await mkdir(path.dirname(socket), { mode: 0o700 });
  // A supervisor killed outright leaves its socket file behind.
  const dead = Bun.spawn(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => console.log("listening"));`,
    ],
    { stdout: "pipe" },
  );
  await dead.stdout.getReader().read();
  dead.kill("SIGKILL");
  await dead.exited;
  expect(existsSync(socket)).toBe(true);
  expect(await ControlSocket.prepare(socket)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(existsSync(socket)).toBe(false);
});

test("refuses a directory others may enter", async () => {
  await mkdir(path.dirname(socket));
  await chmod(path.dirname(socket), 0o755);
  const prepared = await ControlSocket.prepare(socket);
  expect(prepared.ok).toBe(false);
});
