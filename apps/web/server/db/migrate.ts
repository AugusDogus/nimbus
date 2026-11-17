import path from "node:path";
import { backups } from "../backup";
import { getConfigRoot } from "../storage-paths";
import { DatabaseFiles } from "./database-files";
import { client, databasePath } from "./index";
import { upgradeDatabase } from "./migrate-database";

try {
  DatabaseFiles.requireWritable(client, databasePath);
  await upgradeDatabase(client, async () =>
    path.join(getConfigRoot(), "backups", (await backups().run()).name),
  );
  DatabaseFiles.restrict(databasePath);
} finally {
  client.close();
}
console.info("Nimbus database is ready.");
