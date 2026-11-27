import { useNavigate } from "@tanstack/react-router";
import { TabsContent } from "@/components/ui/tabs";
import { useBackOnly } from "../files/folder-card";
import { LibraryPage } from "../library-page";
import { PublicLinks } from "./public-links";
import { FileRequests } from "./file-requests";
import { SharedFrame, type SharedTab } from "./shared-frame";

export function SharedTabs({
  tab,
  sort,
}: {
  tab: SharedTab;
  /** The order of the files shared with you, from the address. */
  sort: string | undefined;
}) {
  const navigate = useNavigate();
  const moves = useBackOnly();
  const onTab = (next: SharedTab) =>
    void navigate({
      to: "/shared",
      search: next === "with-me" ? {} : { tab: next },
      replace: true,
      resetScroll: false,
    });
  // The files shared with you put their sort, view and selection bar on the card's header.
  if (tab === "with-me")
    return (
      <LibraryPage
        kind="shared"
        sort={sort}
        frame={({ tools, attachToolbar, body }) => (
          <SharedFrame
            tab={tab}
            onTab={onTab}
            moves={moves}
            tools={tools}
            attachToolbar={attachToolbar}
          >
            <TabsContent value="with-me">{body}</TabsContent>
          </SharedFrame>
        )}
      />
    );
  return (
    <SharedFrame
      tab={tab}
      onTab={onTab}
      moves={moves}
      tools={null}
      attachToolbar={() => undefined}
    >
      <TabsContent value="links">
        <PublicLinks />
      </TabsContent>
      <TabsContent value="requests">
        <FileRequests />
      </TabsContent>
    </SharedFrame>
  );
}
