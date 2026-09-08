import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCaller, getSession } from "@/server/files-data";
import { SettingsShell } from "./settings-shell";

export default async function SettingsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const me = await (await getCaller()).access.me();
  return <SettingsShell isAdmin={me.isAdmin}>{children}</SettingsShell>;
}
