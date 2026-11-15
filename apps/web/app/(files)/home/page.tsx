import { redirect } from "next/navigation";

import { getCaller } from "@/server/files-data";
import { fileHref } from "../[[...path]]/types";

/** "My files" opens the account's home folder, or the drive when it has none. */
export default async function Page() {
  const { home } = await (await getCaller()).access.me();
  redirect(fileHref(home ?? ""));
}
