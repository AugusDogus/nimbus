import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { readInlineJson } from "@/lib/inline-json";

/**
 * Public pages, the share and upload pages and the sign-in pages, arrive rendered by the server
 * and hydrate through entries of their own, which load nothing of the signed-in app.
 */
export const publicPageElementId = "nimbus-page";

/** The providers around a public page, the same on the server and in the browser. */
export function PublicRoot({
  queryClient,
  children,
}: {
  queryClient: QueryClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

/** The page's data, checked by `parse`; throws when the page arrived without it. */
export function readPublicPage<T>(parse: (value: unknown) => T | undefined): T {
  const data = parse(readInlineJson(publicPageElementId));
  if (data === undefined)
    throw new Error(
      "This page arrived incomplete. Reload it; if it persists, ask the owner for a new link.",
    );
  return data;
}

/** Makes the server's markup interactive, after the browser has painted it. */
export function hydratePublicPage(queryClient: QueryClient, page: ReactNode) {
  const root = document.getElementById("root");
  if (!root)
    throw new Error(
      "This page is missing its #root element. Reload it; if it persists, rebuild Nimbus.",
    );
  // Hydrating in the task that parsed the page would hold the first paint back until it ends.
  requestAnimationFrame(() =>
    setTimeout(() =>
      hydrateRoot(
        root,
        <StrictMode>
          <PublicRoot queryClient={queryClient}>{page}</PublicRoot>
        </StrictMode>,
      ),
    ),
  );
}
