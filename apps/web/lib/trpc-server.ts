import { driveStore } from "@/server/services";

import { createHydrationHelpers } from "@trpc/react-query/rsc";
import { headers } from "next/headers";
import { cache } from "react";

import { createContext } from "@nimbus/api/context";
import { createCaller, type AppRouter } from "@nimbus/api/routers";

import { auth } from "@/lib/auth";
import { preferencesStore } from "@/server/preferences";

import { createQueryClient } from "./query-client";

const createServerContext = cache(async () => {
  const heads = new Headers(await headers());
  heads.set("x-trpc-source", "rsc");
  return createContext({
    auth,
    headers: heads,
    preferences: preferencesStore,
    drive: driveStore,
  });
});

const getQueryClient = cache(createQueryClient);
const caller = createCaller(createServerContext);

export const { trpc: api, HydrateClient } = createHydrationHelpers<AppRouter>(
  caller,
  getQueryClient,
);
