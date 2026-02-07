import type { ReactNode } from "react";

import { getInitialPrefs, getSession } from "@/server/files-data";
import { FilesShell } from "./files-shell";

type FilesLayoutProps = {
  children: ReactNode;
};

export default async function FilesLayout({ children }: FilesLayoutProps) {
  const session = await getSession();
  const initialPrefs = await getInitialPrefs();

  return (
    <FilesShell initialSession={session ?? null} initialPrefs={initialPrefs}>
      {children}
    </FilesShell>
  );
}
