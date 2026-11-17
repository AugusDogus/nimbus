import { createFileRoute } from "@tanstack/react-router";
import { SearchParams } from "@/client/search-params";
import { loadFromServer } from "@/client/server-page";

// The server renders sign-in; see server/auth-pages.tsx.
export const Route = createFileRoute("/login")({
  validateSearch: (search): { error?: string; callbackURL?: string } => ({
    error: SearchParams.string(search, "error"),
    callbackURL: SearchParams.string(search, "callbackURL"),
  }),
  beforeLoad: ({ location }) => loadFromServer(location.href),
});
