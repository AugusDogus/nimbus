import { client, db } from "./index";
import { migrateDatabase } from "./migrate-database";

try {
  migrateDatabase(client, db);
} finally {
  client.close();
}
console.info("Nimbus database is ready.");
