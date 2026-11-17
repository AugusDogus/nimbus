import path from "node:path";
import { backups } from "../backup";
import { getConfigRoot } from "../storage-paths";
import { client } from "./index";
import { upgradeDatabase } from "./migrate-database";

try {
  await upgradeDatabase(client, async () =>
    path.join(getConfigRoot(), "backups", (await backups().run()).name),
  );
} finally {
  client.close();
}
console.info("Nimbus database is ready.");
