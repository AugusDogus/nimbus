import "@/app/globals.css";
import "@/app/fonts.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { lazyComponent } from "@/components/lazy-component";
import { ThemeProvider } from "@/components/theme-provider";
import { sessionQuery } from "@/lib/session-query";
import { queryClient } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import { Bootstrap } from "./bootstrap";
import { router } from "./router";

// A session that ended elsewhere, such as by signing out everywhere, sends the next request's
// page to sign-in, as the server-rendered pages did.
queryClient.getQueryCache().subscribe((event) => {
  if (
    event.type === "updated" &&
    event.action.type === "error" &&
    trpcErrorCode(event.action.error) === "UNAUTHORIZED"
  ) {
    queryClient.removeQueries({ queryKey: sessionQuery.queryKey });
    void router.navigate({ to: "/login" });
  }
});

Bootstrap.seed(queryClient);

// The toast UI loads after the first render; toasts asked for before then wait for it.
const Toaster = lazyComponent(async () => ({
  default: (await import("@/components/toaster")).Toaster,
}));

const container = document.getElementById("root");
if (!container)
  throw new Error(
    "The page is missing its #root element. Reload the page; if it persists, rebuild Nimbus.",
  );

// The page shows its skeleton until the first route has its code and data, so the app replaces
// it with finished content instead of an empty frame. A top-level await here would make the
// bundler split the entry into many more files.
void router.load().then(() =>
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
        <Toaster />
      </QueryClientProvider>
    </StrictMode>,
  ),
);
