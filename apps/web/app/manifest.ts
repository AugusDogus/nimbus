import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Nimbus",
    short_name: "Nimbus",
    description: "Nimbus is a fast, live-updating file browser for your data.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Matches the default light theme; the page updates theme-color at runtime.
    background_color: "#f7f8fa",
    theme_color: "#f7f8fa",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
