import { useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
    <Tabs
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
      className="gap-6"
    >
      <TabsList aria-label="Shared files" activateOnFocus>
        {tabs.map(({ value, label }) => (
          <TabsTrigger key={value} value={value}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="with-me">
        <LibraryPage kind="shared" />
      </TabsContent>
      <TabsContent value="links">
        <PublicLinks />
      </TabsContent>
      <TabsContent value="requests">
        <FileRequests />
      </TabsContent>
    </Tabs>
  );
}
