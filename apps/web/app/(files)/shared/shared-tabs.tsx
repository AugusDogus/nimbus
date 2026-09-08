"use client";

import { useRouter } from "next/navigation";
import { Tabs } from "radix-ui";
import { LibraryPage } from "../library-page";
import { PublicLinks } from "./public-links";

export function SharedTabs({ tab }: { tab: "with-me" | "links" }) {
  const router = useRouter();

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => {
        router.replace(value === "links" ? "/shared?tab=links" : "/shared", {
          scroll: false,
        });
      }}
      className="space-y-6"
    >
      <Tabs.List
        aria-label="Shared files"
        className="inline-flex gap-1 rounded-lg bg-muted p-1"
      >
        {[
          { value: "with-me", label: "Shared with me" },
          { value: "links", label: "Public links" },
        ].map(({ value, label }) => (
          <Tabs.Trigger
            key={value}
            value={value}
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            {label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="with-me">
        <LibraryPage kind="shared" />
      </Tabs.Content>
      <Tabs.Content value="links">
        <PublicLinks />
      </Tabs.Content>
    </Tabs.Root>
  );
}
