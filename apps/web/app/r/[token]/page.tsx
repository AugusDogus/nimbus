import type { Metadata } from "next";
import { FileRequestUpload } from "./file-request-upload";

export const metadata: Metadata = {
  title: "Upload files · Nimbus",
  robots: { index: false, follow: false },
};

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <FileRequestUpload token={token} />;
}
