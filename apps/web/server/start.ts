import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import next from "next";
import { migrate } from "drizzle-orm/libsql/migrator";
import { getDataRoot } from "@nimbus/api/data-root";
import { client, db } from "./db";
import { createDriveStore } from "./drive-store";
import { handleWebDAV } from "./webdav";
import { streamBody } from "./http-files";
import { cleanExpiredData } from "./maintenance";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a number between 1 and 65535.");
}
if (
  !process.env.BETTER_AUTH_SECRET ||
  process.env.BETTER_AUTH_SECRET.length < 32
) {
  throw new Error(
    "Set BETTER_AUTH_SECRET to a random value of at least 32 characters. Run bun run setup for local setup.",
  );
}
const origin = new URL(
  process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
);
await migrate(db, {
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
});
const app = next({
  dev: process.env.NODE_ENV !== "production",
  hostname: "0.0.0.0",
  port,
});
await app.prepare();
const handleNext = app.getRequestHandler();

async function* responseChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? "/", origin);
    if (url.pathname !== "/dav" && !url.pathname.startsWith("/dav/")) {
      await handleNext(incoming, outgoing);
      return;
    }
    // URL parsing drops a fragment, which would retarget a DELETE or MOVE at the parent.
    if (incoming.url?.includes("#")) {
      outgoing
        .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
        .end("WebDAV request URLs cannot contain a fragment (#). Percent-encode # in file names as %23.");
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value))
        for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const method = incoming.method ?? "GET";
    const init = {
      method,
      headers,
      ...(method === "GET" || method === "HEAD"
        ? {}
        : { body: streamBody(incoming), duplex: "half" }),
    };
    const response = await handleWebDAV(new Request(url, init));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    if (response.body) await pipeline(responseChunks(response.body), outgoing);
    else outgoing.end();
  } catch (error) {
    if (outgoing.destroyed) return;
    console.error(
      `Nimbus request failed: ${incoming.method} ${incoming.url}`,
      error,
    );
    if (outgoing.headersSent) outgoing.destroy();
    else
      outgoing
        .writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
        .end("The request failed. Check the server logs and try again.");
  }
});
server.listen(port, "0.0.0.0", () =>
  console.info(`Nimbus is ready at http://localhost:${port}`),
);

const store = createDriveStore(db);
let pendingCleanup: Promise<void> | undefined;
function cleanup() {
  pendingCleanup ??= cleanExpiredData(store, getDataRoot())
    .catch((error: unknown) =>
      console.error(
        "Nimbus retention cleanup failed. Remaining items will be retried in one hour.",
        error,
      ),
    )
    .finally(() => {
      pendingCleanup = undefined;
    });
  return pendingCleanup;
}
void cleanup();
const cleanupTimer = setInterval(cleanup, 60 * 60 * 1000);
cleanupTimer.unref();

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  const deadline = setTimeout(() => {
    console.error(
      "Nimbus shutdown exceeded 30 seconds. Closing remaining connections.",
    );
    server.closeAllConnections();
    client.close();
    process.exit(1);
  }, 30_000);
  deadline.unref();
  server.close(() => {
    void (async () => {
      await pendingCleanup;
      await app.close();
      client.close();
      clearTimeout(deadline);
      process.exit(0);
    })().catch((error: unknown) => {
      console.error("Nimbus shutdown failed.", error);
      process.exit(1);
    });
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
