import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { getConfigRoot, getDatabaseUrl } from "../storage-paths";
import * as schema from "./schema";

const stateDirectory = getConfigRoot();
const databaseUrl = getDatabaseUrl();
mkdirSync(stateDirectory, { recursive: true });

declare global {
  var nimbusDbClient: Client | undefined;
}
export const client =
  globalThis.nimbusDbClient ?? createClient({ url: databaseUrl });
if (process.env.NODE_ENV !== "production") globalThis.nimbusDbClient = client;
export const db = drizzle(client, { schema });
