import { createFileRoute } from "@tanstack/react-router";
import { ThemeSettings } from "@/app/settings/appearance/theme-settings";

export const Route = createFileRoute("/_authed/settings/appearance")({
  component: ThemeSettings,
});
