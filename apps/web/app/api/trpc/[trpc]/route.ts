import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";

import { createContext } from "@nimbus/api/context";
import { appRouter } from "@nimbus/api/routers";

import { auth } from "@/lib/auth";
import { ensureFileWatcher } from "@/server/file-watcher";

ensureFileWatcher();

const handler = async (req: NextRequest) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    router: appRouter,
    req,
    createContext: () =>
      createContext({
        auth,
        headers: req.headers,
      }),
    onError({ error, path }) {
      console.error(`>>> tRPC Error on '${path ?? "unknown"}'`, error);
    },
  });
};

export { handler as GET, handler as POST };

