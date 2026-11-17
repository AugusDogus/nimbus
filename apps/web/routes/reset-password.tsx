import { createFileRoute } from "@tanstack/react-router";
import { SearchParams } from "@/client/search-params";
import { loadFromServer } from "@/client/server-page";

// The server renders password reset; see server/auth-pages.tsx.
export const Route = createFileRoute("/reset-password")({
  validateSearch: (search): { token?: string; error?: string } => ({
    token: SearchParams.string(search, "token"),
    error: SearchParams.string(search, "error"),
  }),
  beforeLoad: ({ location }) => loadFromServer(location.href),
});
