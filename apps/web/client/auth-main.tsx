import "@/app/globals.css";
import "@/app/fonts.css";
import { AuthPageData } from "@/app/auth/auth-page-data";
import { AuthScreen } from "@/app/auth/auth-screen";
import { createQueryClient } from "@/lib/query-client";
import { hydratePublicPage, readPublicPage } from "./public-page";

const data = readPublicPage(AuthPageData.parse);
hydratePublicPage(createQueryClient(), <AuthScreen data={data} />);
