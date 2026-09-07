import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { getDataRoot } from "@nimbus/api/data-root";
import * as schema from "./schema";

const stateDirectory = path.join(getDataRoot(), ".nimbus");
mkdirSync(stateDirectory, { recursive: true });
const databaseUrl = process.env.DATABASE_URL ?? `file:${path.join(stateDirectory, "db.sqlite")}`;

declare global { var nimbusDbClient: Client | undefined; }
export const client = globalThis.nimbusDbClient ?? createClient({ url: databaseUrl });
if (process.env.NODE_ENV !== "production") globalThis.nimbusDbClient = client;
export const db = drizzle(client, { schema });
