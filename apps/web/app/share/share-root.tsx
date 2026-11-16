import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme-provider";
import { PublicShare } from "./public-share";

/**
 * The public share page as both the server renders it and the browser hydrates it: the same
 * providers and component on both sides, so the markup matches.
 */
export function ShareRoot({
  queryClient,
  token,
}: {
  queryClient: QueryClient;
  token: string;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <PublicShare token={token} />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
