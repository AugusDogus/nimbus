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

export async function createContext({
  auth,
  headers,
  preferences,
}: CreateContextOptions) {
  const session = await auth.api.getSession({ headers });
  return {
    headers,
    session,
    preferences,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
