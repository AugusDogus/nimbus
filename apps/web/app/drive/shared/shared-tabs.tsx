import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "@base-ui/react/tabs";
import { LibraryPage } from "../library-page";
import { PublicLinks } from "./public-links";
import { FileRequests } from "./file-requests";

export type SharedTab = "with-me" | "links" | "requests";
const tabs: { value: SharedTab; label: string }[] = [
  { value: "with-me", label: "Shared with me" },
  { value: "links", label: "Public links" },
  { value: "requests", label: "File requests" },
];

export function SharedTabs({ tab }: { tab: SharedTab }) {
  const navigate = useNavigate();

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(value) => {
        const next = tabs.find((entry) => entry.value === value)?.value;
        if (next)
          void navigate({
            to: "/shared",
            search: next === "with-me" ? {} : { tab: next },
            replace: true,
            resetScroll: false,
          });
      }}
      className="space-y-6"
    >
      <Tabs.List
        aria-label="Shared files"
        activateOnFocus
        className="inline-flex gap-1 rounded-lg bg-muted p-1"
      >
        {tabs.map(({ value, label }) => (
          <Tabs.Tab
            key={value}
            value={value}
            className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring data-active:bg-background data-active:text-foreground data-active:shadow-sm"
          >
            {label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <Tabs.Panel value="with-me">
        <LibraryPage kind="shared" />
      </Tabs.Panel>
      <Tabs.Panel value="links">
        <PublicLinks />
      </Tabs.Panel>
      <Tabs.Panel value="requests">
        <FileRequests />
      </Tabs.Panel>
    </Tabs.Root>
  );
}
