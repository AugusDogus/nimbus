/**
 * Waits, as the servers' user, until no server of an earlier start holds a lease on the
 * installation (InstallationLock.awaitLeases). The supervisor runs it when its servers have a
 * user of their own (Users): their lease files are theirs, and the supervisor cannot open them.
 * Exits 0 once every lease is free; otherwise prints why on standard error and exits 1.
 */
import { InstallationLock } from "../installation-lock";
import { getConfigRoot } from "../storage-paths";

const waited = await InstallationLock.awaitLeases(getConfigRoot(), {
  log: (line) => console.warn(`[supervisor] ${line}`),
});
if (!waited.ok) {
  console.error(waited.error.message);
  process.exit(1);
}
