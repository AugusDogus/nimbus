import { redirect } from "next/navigation";
import { getSession } from "@/server/files-data";
import { WebDavSettings } from "./webdav-settings";

export default async function WebDavPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <WebDavSettings email={session.user.email} />;
}
