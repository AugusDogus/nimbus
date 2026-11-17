import "@/app/globals.css";
import "@/app/fonts.css";
import { PublicShare } from "@/app/share/public-share";
import { SharePageData } from "@/app/share/share-page-data";
import { publicShareQuery } from "@/app/share/share-result";
import { createQueryClient } from "@/lib/query-client";
import { hydratePublicPage, readPublicPage } from "./public-page";

const data = readPublicPage(SharePageData.parse);
const queryClient = createQueryClient();
queryClient.setQueryData(
  publicShareQuery(data.token, "").queryKey,
  data.result,
);
hydratePublicPage(queryClient, <PublicShare token={data.token} />);
