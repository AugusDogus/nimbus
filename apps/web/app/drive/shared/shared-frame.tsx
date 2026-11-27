import type { ReactNode } from "react";
import { PageLayout } from "@/components/page-layout";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FolderCard, type FolderMoves } from "../files/folder-card";
import { pageTitles } from "../list-filters";

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
 * Shared's card: its title, the chosen tab's tools after it, and its tabs around the tab's
 * content. The page uses it, and the server's placeholder for it, which passes what each tab shows
 * while it loads.
 */
export function SharedFrame({
  tab,
  onTab,
  moves,
  tools,
  attachToolbar,
  children,
}: {
  tab: SharedTab;
  onTab: (tab: SharedTab) => void;
  moves: FolderMoves;
  /** Sort and view for the files shared with you; the other tabs have none. */
  tools: ReactNode;
  attachToolbar: (element: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  return (
    <FolderCard
      pane={null}
      attachToolbar={attachToolbar}
      moves={moves}
      breadcrumbs={
        <h1 className={PageLayout.cardTitle}>{pageTitles.shared}</h1>
      }
      tools={tools}
      body={
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
      }
    />
  );
}
