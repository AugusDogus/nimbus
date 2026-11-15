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
// and paths, so gzip shrinks them by an order of magnitude. Event streams stay uncompressed.
function compress(request: NextRequest, response: Response) {
  if (
    !response.body ||
    response.headers.has("content-encoding") ||
    !response.headers.get("content-type")?.startsWith("application/json") ||
    !/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")
  )
    return response;
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.append("vary", "accept-encoding");
  headers.delete("content-length");
  return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
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
  return compress(req, response);
};

export { handler as GET, handler as POST };

