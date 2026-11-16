// Must run before zod loads: it turns off zod's eval probe, which the CSP would report.
import "./zod-jitless";
import "@/app/globals.css";
import "@/app/fonts.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { sessionQuery } from "@/lib/session-query";
import { queryClient } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
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

const container = document.getElementById("root");
if (!container)
  throw new Error(
    "The page is missing its #root element. Reload the page; if it persists, rebuild Nimbus.",
  );

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
