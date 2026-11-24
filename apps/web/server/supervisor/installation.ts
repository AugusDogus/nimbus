/**
 * Holds the installation lock for the supervisor (see InstallationLock), as the servers' user:
 * the config root and its lock and leases are theirs, and the supervisor, root when the users
 * are split, opens nothing in it. Takes the lock, waits until no server of an earlier start
 * holds a lease, writes `{"held":true}` on standard output, and then holds the lock until its
 * standard input closes, which it does when the supervisor exits. Failing, it says why on
 * standard error and exits 1.
 */
import { mkdir } from "node:fs/promises";
import { InstallationLock } from "../installation-lock";
import { getConfigRoot } from "../storage-paths";

const configRoot = getConfigRoot();
await mkdir(configRoot, { recursive: true });
const held = InstallationLock.acquire(configRoot);
if (!held.ok) {
  console.error(held.error.message);
  process.exit(1);
}
const earlier = await InstallationLock.awaitLeases(configRoot, {
  log: (line) => console.warn(`[supervisor] ${line}`),
});
if (!earlier.ok) {
  console.error(`Nimbus did not start: ${earlier.error.message}`);
  process.exit(1);
}
console.info(JSON.stringify({ held: true }));
// A container stop signals the supervisor, which drains, exits and so closes this input.
process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);
// Nothing is ever sent; only the end matters.
await new Response(Bun.stdin.stream()).arrayBuffer();
held.value.release();
process.exit(0);
