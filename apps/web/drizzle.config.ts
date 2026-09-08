import { type Config } from "drizzle-kit";
import { getDatabaseUrl } from "./server/storage-paths";

const databaseUrl = getDatabaseUrl();

export default {
  out: "./drizzle",
  schema: "./server/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
