import { gzipSync } from "node:zlib";
import { driveStore } from "@/server/services";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createContext } from "@nimbus/api/context";

import { auth } from "@/lib/auth";
import { ensureFileWatcher } from "@/server/file-watcher";
import { preferencesStore } from "@/server/preferences";
import { webRouter } from "@/server/web-router";

ensureFileWatcher();

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
    !/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")
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
      console.error(`>>> tRPC Error on '${path ?? "unknown"}'`, error);
    },
  });
  return await compress(req, response);
};

export { handler as GET, handler as POST };
