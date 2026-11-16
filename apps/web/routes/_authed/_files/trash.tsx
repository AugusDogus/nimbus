import { createFileRoute } from "@tanstack/react-router";
import { TrashPage } from "@/app/drive/trash/trash-page";

export const Route = createFileRoute("/_authed/_files/trash")({
  component: TrashPage,
});
