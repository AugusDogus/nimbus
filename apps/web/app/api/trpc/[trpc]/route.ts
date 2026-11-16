import { gzipSync } from "node:zlib";
import { driveStore } from "@/server/services";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

import { createContext } from "@nimbus/api/context";
import { appRouter } from "@nimbus/api/routers";

import { auth } from "@/lib/auth";
import { ensureFileWatcher } from "@/server/file-watcher";
import { preferencesStore } from "@/server/preferences";

ensureFileWatcher();

// Next does not compress route handler responses. Large listings are mostly repeated JSON keys
// and paths: a 50,000-entry folder shrinks from 6.1 MB to 283 KB. Level 3 measured both smaller
// and about three times faster than the default level. JSON query responses are complete
// documents, so compressing the whole body adds no latency. Event streams stay uncompressed.
const minimumCompressedBytes = 1024;

async function compress(request: NextRequest, response: Response) {
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

const handler = async (req: NextRequest) => {
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    router: appRouter,
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
