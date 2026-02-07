import type { ReactNode } from "react";

import { headers } from "next/headers";

import { auth } from "@/lib/auth";

import { FilesShell } from "./files-shell";

type FilesLayoutProps = {
  children: ReactNode;
};

export default async function FilesLayout({ children }: FilesLayoutProps) {
  const session = await auth.api.getSession({ headers: await headers() });
  return <FilesShell initialSession={session ?? null}>{children}</FilesShell>;
}
