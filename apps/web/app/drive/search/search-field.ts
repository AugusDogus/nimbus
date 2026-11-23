import { PageLayout } from "@/components/page-layout";
import { cn } from "@/lib/utils";

/**
 * The header's search field, as `SearchBox` renders it and as a page's skeleton draws it before
 * the app runs. On the window's tint from 768 px the field is a white surface of its own.
 */
export const SearchField = {
  form: cn("relative min-w-0 flex-1", PageLayout.searchPlace),
  icon: "pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground",
  input:
    "h-9 rounded-lg border-transparent bg-muted/70 pl-10 shadow-none focus-visible:border-ring pointer-coarse:h-11 md:h-10 md:border-border/80 md:bg-card md:pointer-coarse:h-11 max-md:dark:bg-sidebar/70",
  placeholder: "Search files",
} as const;
