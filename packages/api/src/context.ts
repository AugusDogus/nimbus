export type AuthApi = {
  getSession: (options: { headers: Headers }) => Promise<unknown>;
};

export type AuthLike = {
  api: AuthApi;
};

export type UserPreferences = {
  view: "list" | "grid";
  sortField: "name" | "type" | "modified" | "size";
  sortDirection: "asc" | "desc";
  groupByType: boolean;
};

export type PreferencesStore = {
  getUserPreferences: (userId: string) => Promise<UserPreferences | null>;
  setUserPreferences: (
    userId: string,
    preferences: UserPreferences,
  ) => Promise<UserPreferences>;
};

export type CreateContextOptions = {
  auth: AuthLike;
  headers: Headers;
  preferences: PreferencesStore;
};

const getTestSession = () => {
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
  };
};

export async function createContext({
  auth,
  headers,
  preferences,
}: CreateContextOptions) {
  const session = getTestSession() ?? (await auth.api.getSession({ headers }));
  return {
    headers,
    session,
    preferences,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
