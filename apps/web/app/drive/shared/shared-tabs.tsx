import { useNavigate } from "@tanstack/react-router";
import { TabsContent } from "@/components/ui/tabs";
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
  return (
    <SharedFrame
      tab={tab}
      onTab={(next) =>
        void navigate({
          to: "/shared",
          search: next === "with-me" ? {} : { tab: next },
          replace: true,
          resetScroll: false,
        })
      }
    >
      <TabsContent value="with-me">
        <LibraryPage kind="shared" sort={sort} />
      </TabsContent>
      <TabsContent value="links">
        <PublicLinks />
      </TabsContent>
      <TabsContent value="requests">
        <FileRequests />
      </TabsContent>
    </SharedFrame>
  );
}
