import type {} from "webmcp-types";
import { useEffect, useRef } from "react";
import { CodeLoad } from "@/lib/code-load";
import type { FileToolsPage } from "./webmcp-file-tools";

/**
 * Exposes the folder view to in-browser agents through WebMCP when the
 * browser supports it. The tool code is a separate chunk, loaded only after
 * feature detection, so other browsers download nothing extra.
 */
export function WebMcpFileTools(page: FileToolsPage) {
  const latest = useRef(page);
  useEffect(() => {
    latest.current = page;
  });
  useEffect(() => {
    const context = document.modelContext;
    if (!window.isSecureContext || typeof context?.registerTool !== "function")
      return;
    const lifetime = new AbortController();
    void CodeLoad.load(() => import("./webmcp-file-tools"))
      .then(({ registerFileTools }) => {
        if (!lifetime.signal.aborted)
          return registerFileTools(
            context,
            () => latest.current,
            lifetime.signal,
          );
      })
      .catch((error: unknown) => {
        if (lifetime.signal.aborted) return;
        // Unregister anything that did register; the page keeps working without agent tools.
        lifetime.abort();
        console.warn(
          "Nimbus could not offer its page tools to the browser's agent.",
          error,
        );
      });
    return () => lifetime.abort();
  }, []);
  return null;
}
