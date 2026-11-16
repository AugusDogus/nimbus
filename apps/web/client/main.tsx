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
import { queryClient } from "@/lib/trpc";
import { router } from "./router";

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
