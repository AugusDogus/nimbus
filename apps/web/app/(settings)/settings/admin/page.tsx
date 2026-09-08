import { getCaller } from "@/server/files-data";
import { AdminSettings } from "./admin-settings";

export default async function AdminPage() {
  const me = await (await getCaller()).access.me();
  if (!me.isAdmin) {
    return <p role="alert">Only server administrators can open this page.</p>;
  }
  return <AdminSettings />;
}
