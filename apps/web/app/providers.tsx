"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";

import { ThemeProvider } from "@/components/theme-provider";
import { queryClient } from "@/lib/trpc";
import { createQueryClient } from "@/lib/query-client";

type ProvidersProps = {
  children: ReactNode;
};

export default function Providers({ children }: ProvidersProps) {
  // Server renders must never reuse another request's authenticated query data.
  // Browser actions share the client exported by lib/trpc.
  const [client] = useState(() =>
    typeof window === "undefined" ? createQueryClient() : queryClient,
  );
  return (
    <QueryClientProvider client={client}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        {children}
      </ThemeProvider>
    </QueryClientProvider>
  );
}
