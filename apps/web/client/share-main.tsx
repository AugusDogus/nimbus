// Must run before zod loads: it turns off zod's eval probe, which the CSP would report.
import "./zod-jitless";
import "@/app/globals.css";
import "@/app/fonts.css";
import { hydrateRoot } from "react-dom/client";
import { StrictMode } from "react";
import { SharePageData, sharePageElementId } from "@/app/share/share-page-data";
import { ShareRoot } from "@/app/share/share-root";
import { publicShareQuery } from "@/app/share/share-result";
import { createQueryClient } from "@/lib/query-client";

// The public share page arrives rendered by the server; this makes it interactive. It loads
// nothing of the signed-in app.
const root = document.getElementById("root");
const data = SharePageData.parse(
  document.getElementById(sharePageElementId)?.textContent ?? "",
);
if (!root || !data)
  throw new Error(
    "This share page arrived incomplete. Reload it; if it persists, ask the owner for a new link.",
  );
const queryClient = createQueryClient();
queryClient.setQueryData(
  publicShareQuery(data.token, "").queryKey,
  data.result,
);
// Paint the server's markup first: hydrating in the task that parsed the page would hold the
// first paint back until hydration finishes.
requestAnimationFrame(() =>
  setTimeout(() =>
    hydrateRoot(
      root,
      <StrictMode>
        <ShareRoot queryClient={queryClient} token={data.token} />
      </StrictMode>,
    ),
  ),
);
