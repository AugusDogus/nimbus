import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type SharedTab = "with-me" | "links" | "requests";
const tabs: { value: SharedTab; label: string }[] = [
  { value: "with-me", label: "Shared with me" },
  { value: "links", label: "Public links" },
  { value: "requests", label: "File requests" },
];

export const SharedTab = {
  /** The tab an address's `tab` names: files shared with you unless it names another. */
  of: (value: string | null | undefined): SharedTab =>
    value === "links" || value === "requests" ? value : "with-me",
} as const;

/**
 * Shared's title and tabs around the chosen tab's content: the page, and the server's
 * placeholder for it, which passes the content each tab shows while it loads.
 */
export function SharedFrame({
  tab,
  onTab,
  children,
}: {
  tab: SharedTab;
  onTab: (tab: SharedTab) => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-balance text-2xl font-semibold">Shared</h1>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = tabs.find((entry) => entry.value === value)?.value;
          if (next) onTab(next);
        }}
        className="gap-6"
      >
        <TabsList
          aria-label="Shared files"
          activateOnFocus
          data-shape="shared-tabs"
        >
          {tabs.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {children}
      </Tabs>
    </div>
  );
}
