import { createFileRoute } from "@tanstack/react-router";
import { PublicShare } from "@/app/share/public-share";

export const Route = createFileRoute("/s/$token")({
  component: function PublicSharePage() {
    const { token } = Route.useParams();
    return <PublicShare token={token} />;
  },
});
