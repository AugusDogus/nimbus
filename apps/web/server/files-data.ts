import "server-only";

import { headers } from "next/headers";
import { cache } from "react";

import type { UserPreferences } from "@nimbus/api/context";
import { createContext } from "@nimbus/api/context";
import { createCaller } from "@nimbus/api/routers";

import { auth } from "@/lib/auth";
import { preferencesStore } from "@/server/preferences";

type SessionData = Awaited<ReturnType<typeof auth.api.getSession>>;

export const getRequestHeaders = cache(async () => headers());

const getTestSession = (): SessionData | null => {
  if (process.env.NIMBUS_TEST_SESSION !== "1") {
    return null;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
  return {
    user: {
      id: "test-user",
      createdAt: now,
      updatedAt: now,
      name: "Test User",
      email: "test@nimbus.local",
      emailVerified: true,
      image: null,
    },
    session: {
      id: "test-session",
      createdAt: now,
      updatedAt: now,
      userId: "test-user",
      expiresAt,
      token: "test-token",
      ipAddress: null,
      userAgent: null,
    },
  } as SessionData;
};

export const getSession = cache(async () => {
  const testSession = getTestSession();
  if (testSession) {
    return testSession;
  }
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

export const getInitialPrefs = cache(async (): Promise<UserPreferences | null> => {
  const session = await getSession();
  if (!session) {
    return null;
  }
  const caller = await getCaller();
  return caller.prefs.get();
});
