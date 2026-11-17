import { gzipSync } from "node:zlib";
import { driveStore } from "@/server/services";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createContext } from "@nimbus/api/context";

import { auth } from "@/lib/auth";
import { preferencesStore } from "@/server/preferences";
import { accepted } from "@/server/static-files";
import { webRouter } from "@/server/web-router";

// The server does not compress responses on its own. A 50,000-entry listing, sent as columns,
// shrinks from 2 MB to 141 KB. Level 3 measured both smaller and about three times faster than
// the default level. JSON query responses are complete documents, so compressing the whole body
// adds no latency. Gzipping that listing takes about 4 ms here; a worker measured no faster end
// to end, so it stays on this thread. Event streams stay uncompressed.
const minimumCompressedBytes = 1024;

async function compress(request: Request, response: Response) {
  if (
    !response.body ||
    response.headers.has("content-encoding") ||
    !response.headers.get("content-type")?.startsWith("application/json") ||
    !accepted(request.headers.get("accept-encoding")).gzip
  )
    return response;
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.append("vary", "accept-encoding");
  if (body.byteLength < minimumCompressedBytes)
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  const compressed = gzipSync(body, { level: 3 });
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(compressed.byteLength));
  return new Response(compressed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const handler = async (req: Request) => {
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    router: webRouter,
    req,
    createContext: () =>
      createContext({
        auth,
        headers: req.headers,
        preferences: preferencesStore,
        drive: driveStore,
      }),
    onError({ error, path }) {
      // The client went away (a newer search replaced this one): nothing to fix.
      if (error.code === "CLIENT_CLOSED_REQUEST") return;
      console.error(`>>> tRPC Error on '${path ?? "unknown"}'`, error);
    },
  });
  const compressed = await compress(req, response);
  // Results are per user, so no shared cache may store them, and none is worth keeping.
  compressed.headers.set("Cache-Control", "private, no-store");
  return compressed;
};

/** HEAD answers as GET would; tRPC itself has no HEAD and answers 204. */
const head = (req: Request) => handler(new Request(req, { method: "GET" }));

export { handler as GET, head as HEAD, handler as POST };
