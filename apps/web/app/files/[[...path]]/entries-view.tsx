import Link from "next/link";

import { FileText, Folder } from "lucide-react";

import { cn } from "@/lib/utils";

import type { FileEntry } from "./types";

type EntriesViewProps = {
  view: "list" | "grid";
  groupByType: boolean;
  folders: FileEntry[];
  files: FileEntry[];
  sortedEntries: FileEntry[];
};

const gridClassName = (view: "list" | "grid") =>
  cn(
    view === "list"
      ? "space-y-1"
      : "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6",
  );

const EntryItem = ({ entry, view }: { entry: FileEntry; view: "list" | "grid" }) => {
  if (entry.type === "dir") {
    return view === "list" ? (
      <Link
        key={entry.path}
        href={`/files/${entry.path}`}
        className="flex items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
      >
        <Folder className="size-6 fill-muted text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{entry.name}</span>
      </Link>
    ) : (
      <Link
        key={entry.path}
        href={`/files/${entry.path}`}
        className="flex flex-col items-center gap-2 rounded-xl border bg-muted/50 p-3 hover:border-border hover:bg-accent sm:gap-3 sm:p-4"
      >
        <Folder className="size-10 fill-muted text-muted-foreground sm:size-12" />
        <span className="w-full truncate text-center text-xs font-medium sm:text-sm">
          {entry.name}
        </span>
      </Link>
    );
  }

  return view === "list" ? (
    <div
      key={entry.path}
      className="flex cursor-default items-center gap-4 rounded-lg px-4 py-3 hover:bg-accent"
    >
      <FileText className="size-6 text-primary" />
      <span className="flex-1 truncate text-sm">{entry.name}</span>
    </div>
  ) : (
    <div
      key={entry.path}
      className="flex cursor-default flex-col rounded-xl border bg-card hover:border-border hover:shadow-sm"
    >
      <div className="flex h-20 items-center justify-center rounded-t-xl bg-muted sm:h-28">
        <FileText className="size-8 text-primary sm:size-10" />
      </div>
      <div className="border-t p-2 sm:p-3">
        <span className="line-clamp-2 text-xs sm:text-sm">{entry.name}</span>
      </div>
    </div>
  );
};

const EntriesGrid = ({ entries, view }: { entries: FileEntry[]; view: "list" | "grid" }) => (
  <div className={gridClassName(view)}>
    {entries.map((entry) => (
      <EntryItem key={entry.path} entry={entry} view={view} />
    ))}
  </div>
);

export function EntriesView({
  view,
  groupByType,
  folders,
  files,
  sortedEntries,
}: EntriesViewProps) {
  if (!groupByType) {
    return <EntriesGrid entries={sortedEntries} view={view} />;
  }

  return (
    <>
      {folders.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Folders
          </h2>
          <EntriesGrid entries={folders} view={view} />
        </section>
      )}

      {files.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Files
          </h2>
          <EntriesGrid entries={files} view={view} />
        </section>
      )}
    </>
  );
}
