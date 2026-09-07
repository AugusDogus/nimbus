import { type Config } from "drizzle-kit";
import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";

const databaseUrl =
  process.env.DATABASE_URL ??
  `file:${path.join(getDataRoot(), ".nimbus", "db.sqlite")}`;

export default {
  out: "./drizzle",
  schema: "./server/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
