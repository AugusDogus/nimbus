import { type Config } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL ?? "file:./nimbus.db";

export default {
  schema: "./server/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: {
    url: databaseUrl,
  },
} satisfies Config;
