import { createFileRoute } from "@tanstack/react-router";
import { FileRequestUpload } from "@/app/file-request/file-request-upload";

export const Route = createFileRoute("/r/$token")({
  component: function FileRequestPage() {
    const { token } = Route.useParams();
    return (
      <>
        <title>Upload files · Nimbus</title>
        <meta name="robots" content="noindex, nofollow" />
        <FileRequestUpload token={token} />
      </>
    );
  },
});
