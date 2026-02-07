import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import { createContext } from "@nimbus/api/context";
import { createCaller } from "@nimbus/api/routers";

import { auth } from "@/lib/auth";
import { preferencesStore } from "@/server/preferences";

export const getRequestHeaders = cache(async () => headers());

export const getSession = cache(async () => {
  const requestHeaders = await getRequestHeaders();
  return auth.api.getSession({ headers: requestHeaders });
});

export const getCaller = cache(async () => {
  const requestHeaders = await getRequestHeaders();
  return createCaller(
    await createContext({
      auth,
      headers: requestHeaders,
      preferences: preferencesStore,
    }),
  );
});

export const getInitialPrefs = cache(async () => {
  const session = await getSession();
  if (!session) {
    return null;
  }
  const caller = await getCaller();
  return caller.prefs.get();
});
