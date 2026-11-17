import "@/app/globals.css";
import "@/app/fonts.css";
import { FileRequestUpload } from "@/app/file-request/file-request-upload";
import { FileRequestPageData } from "@/app/file-request/file-request-page-data";
import { fileRequestQuery } from "@/app/file-request/file-request-result";
import { createQueryClient } from "@/lib/query-client";
import { hydratePublicPage, readPublicPage } from "./public-page";

const data = readPublicPage(FileRequestPageData.parse);
const queryClient = createQueryClient();
queryClient.setQueryData(fileRequestQuery(data.token).queryKey, data.result);
hydratePublicPage(queryClient, <FileRequestUpload token={data.token} />);
