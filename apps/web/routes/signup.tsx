import { createFileRoute } from "@tanstack/react-router";
import { loadFromServer } from "@/client/server-page";

// The server renders sign-up; see server/auth-pages.tsx.
export const Route = createFileRoute("/signup")({
  beforeLoad: ({ location }) => loadFromServer(location.href),
});
