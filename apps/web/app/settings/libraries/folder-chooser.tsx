import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, Folder } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DriveRoot } from "@nimbus/api/drive-root";
import { fileListQueryOptions } from "@/app/drive/files/use-file-list";

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * Browse the drive's folders and choose one, with the same folder listing the file browser
 * uses. The top of the drive can be browsed but not chosen; the server checks every choice.
 */
export function FolderChooser({
  onChoose,
  onCancel,
}: {
  onChoose: (path: string) => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState("");
  const listing = useQuery(fileListQueryOptions(path, false));
  const folders = (listing.data ?? [])
    .filter((entry) => entry.type === "dir" && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={path === ""}
          onClick={() => setPath(parentOf(path))}
          aria-label="Up one folder"
        >
          <ArrowUp aria-hidden="true" />
        </Button>
        <p
          className="min-w-0 truncate text-sm font-medium"
          title={path || DriveRoot.label}
        >
          {path
            ? `${DriveRoot.label} / ${path.split("/").join(" / ")}`
            : DriveRoot.label}
        </p>
      </div>
      <ul
        aria-label="Folders"
        className="max-h-72 divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/60"
      >
        {listing.isPending ? (
          <li className="px-3 py-3 text-sm text-muted-foreground">Loading…</li>
        ) : listing.isError ? (
          <li role="alert" className="px-3 py-3 text-sm text-destructive">
            This folder could not be listed. Go up and try another.
          </li>
        ) : folders.length === 0 ? (
          <li className="px-3 py-3 text-sm text-muted-foreground">
            No folders here
          </li>
        ) : (
          folders.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => setPath(entry.path)}
              >
                <Folder
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Back
        </Button>
        <Button
          type="button"
          disabled={path === ""}
          onClick={() => onChoose(path)}
        >
          Choose this folder
        </Button>
      </div>
    </div>
  );
}
