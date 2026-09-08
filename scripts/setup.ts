import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const app = path.resolve(import.meta.dir, "../apps/web");
const data = path.join(app, "data");
await mkdir(data, { recursive: true });
try {
  await writeFile(
    path.join(app, ".env"),
    `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}\nBETTER_AUTH_URL=http://localhost:3000\nBETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000\nNIMBUS_DATA_ROOT=${data}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.info(
    "Created apps/web/.env with a random auth secret and a local data folder.",
  );
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
    throw error;
  console.info("Kept existing apps/web/.env.");
}
console.info(
  "Run bun dev, then open http://localhost:3000/signup to create the administrator account. The database is migrated automatically at startup.",
);
