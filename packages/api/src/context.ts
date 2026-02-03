export type AuthApi = {
  getSession: (options: { headers: Headers }) => Promise<unknown>;
};

export type AuthLike = {
  api: AuthApi;
};

export type CreateContextOptions = {
  auth: AuthLike;
  headers: Headers;
};

export async function createContext({ auth, headers }: CreateContextOptions) {
  const session = await auth.api.getSession({ headers });
  return {
    headers,
    session,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
