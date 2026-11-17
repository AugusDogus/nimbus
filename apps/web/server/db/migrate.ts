import { client } from "./index";
import { migrateDatabase } from "./migrate-database";

try {
  migrateDatabase(client);
} finally {
  client.close();
}
console.info("Nimbus database is ready.");
