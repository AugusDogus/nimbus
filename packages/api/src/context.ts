import { z } from "zod";
import type { DriveStore } from "./drive-store";

export type AuthApi = {
  getSession: (options: { headers: Headers }) => Promise<unknown>;
};

export type AuthLike = {
  api: AuthApi;
};

/** File browser preferences, validated wherever they enter: API input and stored rows. */
export const UserPreferences = z.object({
  view: z.enum(["list", "grid"]),
  sortField: z.enum(["name", "type", "modified", "size"]),
  sortDirection: z.enum(["asc", "desc"]),
  groupByType: z.boolean(),
});
export type UserPreferences = z.infer<typeof UserPreferences>;

export type PreferencesStore = {
  getUserPreferences: (userId: string) => Promise<UserPreferences | null>;
  setUserPreferences: (
    userId: string,
    preferences: UserPreferences,
  ) => Promise<UserPreferences>;
};

const sessionId = z.object({ session: z.object({ id: z.string() }) });

export type CreateContextOptions = {
  auth: AuthLike;
  headers: Headers;
  preferences: PreferencesStore;
  drive: DriveStore;
};

export async function createContext({
  auth,
  headers,
  preferences,
  drive,
}: CreateContextOptions) {
  const session = await auth.api.getSession({ headers });
  const signedIn = sessionId.safeParse(session);
  return {
    headers,
    session,
    /** Whether this request's session is still signed in. Live event streams re-check it. */
    sessionStillValid: async () => {
      const current = sessionId.safeParse(
        await auth.api.getSession({ headers }),
      );
      return (
        signedIn.success &&
        current.success &&
        current.data.session.id === signedIn.data.session.id
      );
    },
    preferences,
    drive,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
