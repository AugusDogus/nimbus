import { LibraryPage } from "../library-page";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  return <LibraryPage kind="search" query={q?.trim() ?? ""} />;
}
