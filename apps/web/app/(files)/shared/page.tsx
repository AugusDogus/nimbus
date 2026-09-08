import { SharedTabs } from "./shared-tabs";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return (
    <div className="space-y-6">
      <h1 className="text-balance text-2xl font-semibold">Shared</h1>
      <SharedTabs tab={tab === "links" ? "links" : "with-me"} />
    </div>
  );
}
