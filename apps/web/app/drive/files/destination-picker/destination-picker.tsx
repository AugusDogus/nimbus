import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowUp,
  Clock,
  FolderPlus,
  HardDrive,
  Search,
  Star,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WhenDialogClosed } from "@/components/when-dialog-closed";
import { useIsMobile } from "@/hooks/use-mobile";
import { queryClient, trpc, trpcClient } from "@/lib/trpc";
import { sessionQuery } from "@/lib/session-query";
import { trpcErrorCode } from "@/lib/trpc-error";
import { cn } from "@/lib/utils";
import { DriveRoot } from "@nimbus/api/drive-root";
import { BreadcrumbTrail } from "../breadcrumb-trail";
import { DropTarget } from "../drop-target";
import { sortEntries } from "../entry-sort";
import { TransferReport } from "../transfer-report";
import type { TransferOperation, TransferResult } from "../transfer-result";
import type { FileEntry } from "../types";
import type { useFileActions } from "../use-file-actions";
import { dialogOpener } from "../use-entry-dialog";
import { fileListQueryOptions } from "../use-file-list";
import { needsStats, prefsQueryOptions } from "../use-file-preferences";
import { FolderList, type FolderRow } from "./folder-list";
import { RecentDestinations } from "./recent-destinations";
import { folderName } from "./folder-name";
import { TransferSession } from "./transfer-session";
import { ClashPanel, FailurePanel, type ClashChoice } from "./transfer-panels";

/**
 * A folder offered above the account's own places, such as the folder open in the other pane
 * of a split view. The rail lists any it is given first.
 */
export type PinnedPlace = { label: string; path: string };

type View =
  | { kind: "folder"; path: string }
  | { kind: "starred" }
  | { kind: "recent" };

type Phase =
  | { kind: "choosing" }
  | { kind: "working" }
  /** Some items' names are taken in the destination; the person decides what to do. */
  | { kind: "clashes"; result: TransferResult }
  /** Some or all items failed; they stay in the picker to try again. */
  | { kind: "failed"; result: TransferResult };

const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/** A folder's location as shown in the footer and search results: "Files / Projects". */
const spelled = (path: string, top: string) => {
  const trail = BreadcrumbTrail.of(path, top, DriveRoot.label);
  return [trail.root, ...trail.crumbs].map((crumb) => crumb.label).join(" / ");
};

const subjectOf = (entries: readonly FileEntry[]) => {
  const [only] = entries;
  return entries.length === 1 && only
    ? `“${only.name}”`
    : `${entries.length.toLocaleString()} items`;
};

const verbs = {
  move: { title: "Move", working: "Moving…" },
  copy: { title: "Copy", working: "Copying…" },
} as const;

/** The height the visible viewport leaves, which the on-screen keyboard reduces on phones. */
function useVisualViewport(enabled: boolean) {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const update = () =>
      setBox({ top: viewport.offsetTop, height: viewport.height });
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return enabled ? box : null;
}

/**
 * Choose where to move or copy items: a drill-down through folders with a breadcrumb, search
 * across every folder the account can write to, starred and recent destinations, and a new
 * folder made on the spot. It opens where the items are. A dialog on wide screens and a
 * full-height sheet on phones, of one size whatever is shown in it.
 */
export function DestinationPicker({
  operation,
  entries,
  actions,
  onClose,
  pinned = [],
  resume,
}: {
  operation: TransferOperation;
  entries: readonly FileEntry[];
  actions: ReturnType<typeof useFileActions>;
  onClose: () => void;
  pinned?: readonly PinnedPlace[];
  /**
   * A move made without the picker whose names clash in its destination: the picker opens
   * there, asking about the clashes, and reports what already moved however it closes.
   */
  resume?: TransferResult;
}) {
  const mobile = useIsMobile();
  const [first] = entries;
  // Files opens the account's top folder, as the sidebar does: the drive root, or the home of an
  // account limited to it. The picker never leaves it: its breadcrumb is rooted there, and a
  // folder outside it, such as one shared before a grant was revoked, is never opened.
  const me = useQuery({ ...trpc.access.me.queryOptions() }).data;
  const top = me?.top ?? "";
  const withinTop = (path: string) =>
    top === "" || path === top || path.startsWith(`${top}/`);
  const inside = (path: string) => (withinTop(path) ? path : top);
  const [view, setView] = useState<View>(() => ({
    kind: "folder",
    path: inside(
      resume ? resume.destination : first ? parentOf(first.path) : top,
    ),
  }));
  const [history, setHistory] = useState<View[]>([]);
  const [query, setQuery] = useState("");
  // A top folder that changes while the picker is open, such as when a grant outside the home
  // is revoked, starts the picker over there: nothing outside the new top stays in view or in
  // Back's history. The top learned once the account loads only moves a view outside it.
  const [rootedAt, setRootedAt] = useState(me === undefined ? null : top);
  if (me !== undefined && rootedAt !== top) {
    setRootedAt(top);
    if (rootedAt !== null) {
      setHistory([]);
      setView({ kind: "folder", path: top });
      setQuery("");
    } else if (view.kind === "folder" && !withinTop(view.path))
      setView({ kind: "folder", path: top });
  }
  const searched = useDeferredValue(query.trim());
  const [creating, setCreating] = useState<
    { kind: "closed" } | { kind: "naming"; error: string | null; busy: boolean }
  >({ kind: "closed" });
  const [phase, setPhase] = useState<Phase>(
    resume ? { kind: "clashes", result: resume } : { kind: "choosing" },
  );
  // Items still to transfer: all of them at first, then those that failed.
  const [pending, setPending] = useState(entries);
  const busy = phase.kind === "working";
  const account = queryClient.getQueryData(sessionQuery.queryKey)?.user.id;
  const viewport = useVisualViewport(mobile);
  const [opener] = useState(dialogOpener);
  // Focus goes back to what opened the picker; the dialog would pick the menu item, gone by then.
  const returnFocus = () => {
    if (opener?.isConnected) opener.focus();
  };

  // Where focus goes in the next list shown, after moving through folders from the list.
  const [focusRequest, setFocusRequest] = useState<{
    id: number;
    path: string | null;
  }>();
  const focusListAt = (path: string | null) =>
    setFocusRequest((current) => ({ id: (current?.id ?? 0) + 1, path }));

  const go = (next: View) => {
    setHistory((past) => [...past, view]);
    setView(
      next.kind === "folder"
        ? { kind: "folder", path: inside(next.path) }
        : next,
    );
    setQuery("");
    setCreating({ kind: "closed" });
    if (phase.kind === "clashes") setPhase({ kind: "choosing" });
  };
  const back = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((past) => past.slice(0, -1));
    setView(previous);
  };
  const browsed = view.kind === "folder" ? view.path : null;
  const nameOf = (path: string) => folderName(path, top);
  const rootOf = (path: string) =>
    BreadcrumbTrail.of(path, top, DriveRoot.label).root.path;
  const atRoot =
    browsed === null || browsed === rootOf(browsed) || browsed === top;
  const up = () => {
    if (browsed !== null && !atRoot)
      go({ kind: "folder", path: parentOf(browsed) });
  };

  const prefs = useQuery(prefsQueryOptions).data;
  const includeStats = prefs ? needsStats(prefs) : false;
  const listing = useQuery({
    ...fileListQueryOptions(browsed ?? "", includeStats),
    enabled: browsed !== null && !searched,
    placeholderData: keepPreviousData,
  });
  const capability = useQuery({
    queryKey: ["files.destination", browsed],
    queryFn: () => trpcClient.files.destination.query({ path: browsed ?? "" }),
    enabled: browsed !== null,
    retry: (failures, error) =>
      trpcErrorCode(error) !== "NOT_FOUND" &&
      trpcErrorCode(error) !== "FORBIDDEN" &&
      failures < 2,
    staleTime: 10_000,
  });
  // Recent folders inside the top folder, each checked like the folder the picker shows.
  const recentPaths =
    view.kind === "recent" && account
      ? RecentDestinations.list(account).filter(withinTop)
      : [];
  const recentChecks = useQueries({
    queries: recentPaths.map((path) => ({
      queryKey: ["files.destination", path],
      queryFn: () => trpcClient.files.destination.query({ path }),
      retry: false,
      staleTime: 10_000,
    })),
  });
  const starred = useQuery({
    queryKey: ["catalog", "bookmarks"],
    queryFn: () => trpcClient.catalog.bookmarks.query(),
    enabled: view.kind === "starred",
  });
  const results = useQuery({
    queryKey: ["catalog", "destinations", searched],
    queryFn: ({ signal }) =>
      trpcClient.catalog.destinations.query({ query: searched }, { signal }),
    enabled: searched.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });

  // A recent folder that no longer exists leaves the list once opened.
  useEffect(() => {
    if (
      account &&
      browsed !== null &&
      trpcErrorCode(capability.error) === "NOT_FOUND"
    )
      RecentDestinations.forget(account, browsed);
  }, [account, browsed, capability.error]);

  const rowFor = (folder: {
    path: string;
    name: string;
    permission: FileEntry["permission"];
    detail?: string;
  }): FolderRow => ({
    path: folder.path,
    name: folder.name,
    detail: folder.detail,
    eligibility: DropTarget.forItems(operation, pending, {
      path: folder.path,
      writable: folder.permission !== "read",
    }),
  });

  const folderRows = useMemo(() => {
    if (browsed === null || !listing.data) return [];
    const folders = listing.data.filter((entry) => entry.type === "dir");
    return (prefs ? sortEntries(folders, prefs) : folders).map(
      (entry): FolderRow => ({
        path: entry.path,
        name: entry.name,
        eligibility: DropTarget.forItems(operation, pending, {
          path: entry.path,
          writable: entry.permission !== "read",
        }),
      }),
    );
  }, [browsed, listing.data, prefs, operation, pending]);

  // A folder without subfolders has no row to focus: the action that fits it takes focus.
  const submitRef = useRef<HTMLButtonElement>(null);
  const upRef = useRef<HTMLButtonElement>(null);
  const emptyFolder =
    browsed !== null && listing.data !== undefined && folderRows.length === 0;
  // Counts the times focus moved to an action; each change moves it once more.
  const [focusAction, setFocusAction] = useState(0);
  const capabilityKnown =
    capability.data?.path === browsed || capability.isError;
  if (
    focusRequest &&
    emptyFolder &&
    capabilityKnown &&
    !listing.isPlaceholderData
  ) {
    setFocusRequest(undefined);
    setFocusAction((count) => count + 1);
  }
  useEffect(() => {
    if (focusAction === 0) return;
    const submitButton = submitRef.current;
    (submitButton && !submitButton.disabled
      ? submitButton
      : upRef.current
    )?.focus();
  }, [focusAction]);

  const destination: DropTarget | null =
    browsed !== null && capability.data?.path === browsed
      ? { path: browsed, writable: capability.data.permission !== "read" }
      : null;
  const eligibility = destination
    ? DropTarget.forItems(operation, pending, destination)
    : null;

  const reportTransfer = useRef(actions.reportTransfer);
  useEffect(() => {
    reportTransfer.current = actions.reportTransfer;
  });
  /**
   * Everything the picker has done, reported once it has closed, however it closes or is left,
   * and once nothing it started is still running: one report for every destination, with one
   * Undo for all that arrived, Keep both for names still taken, and what failed and why. A
   * toast added while the modal picker is open, or closing, stays hidden from assistive
   * technology and out of reach, so reports wait for it to unmount. The session is held
   * outside the picker, so a transfer that finishes after the picker or its page is gone still
   * reports, on whatever page is open by then.
   */
  const [held] = useState(() =>
    TransferSession.held(
      resume
        ? TransferSession.record(
            TransferSession.start(operation, entries),
            resume,
          )
        : TransferSession.start(operation, entries),
    ),
  );
  /** Transfer `items`, which are open in the session, and record what the server answered. */
  const transfer = (
    items: readonly FileEntry[],
    to: string,
    options: Parameters<typeof actions.transferEntries>[3],
  ) =>
    held.run(() =>
      actions.transferEntries(operation, items, to, {
        ...options,
        // Shown running in the picker while it is open; listed elsewhere once it closes.
        watched: () => mounted.current,
      }),
    );
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A tick later, so a remount in development (React's StrictMode) reports nothing.
      setTimeout(() => {
        if (mounted.current) return;
        held.close((session) => {
          const [first, ...others] = TransferSession.results(session);
          if (first) reportTransfer.current(first, others);
        });
      });
    };
  }, [held]);
  /** Undo, from the picker, what `result` transferred and is still in place; stop reporting it. */
  const undoFromPicker = async (result: TransferResult) => {
    const current = new Set(
      TransferSession.transferred(held.current()).map(
        (item) => item.receipt.id,
      ),
    );
    const undo = await TransferReport.undo(
      {
        ...result,
        transferred: result.transferred.filter((item) =>
          current.has(item.receipt.id),
        ),
      },
      {
        refresh: () => {
          for (const key of ["files.list", "catalog", "trash"])
            void queryClient.invalidateQueries({ queryKey: [key] });
        },
        hold: actions.holdPage,
        watched: () => mounted.current,
      },
    );
    held.update((session) => TransferSession.undone(session, undo.undone));
    return undo;
  };

  /**
   * Show what a finished transfer did, and close, or keep what is left to try again. A picker
   * closed meanwhile does nothing more: its session reports the transfer.
   */
  const settle = (result: TransferResult) => {
    if (!mounted.current) return;
    setPending(TransferSession.pending(held.current()));
    if (result.clashes.length) {
      setPhase({ kind: "clashes", result });
      return;
    }
    if (!result.failed.length) {
      onClose();
      return;
    }
    setPhase({ kind: "failed", result });
  };

  const submitTo = async (to: string) => {
    setPhase({ kind: "working" });
    settle(
      await transfer(pending, to, {
        clash: operation === "move" ? "refuse" : "keep-both",
      }),
    );
  };
  const submit = () => {
    if (!destination || eligibility?.kind !== operation || busy) return;
    void submitTo(destination.path);
  };

  const resolve = async (result: TransferResult, choice: ClashChoice) => {
    const clashing = result.clashes.map((clash) => clash.source);
    switch (choice.kind) {
      case "cancel": {
        // What already reached the destination stays there, with Undo in its report. The items
        // whose names are taken stay where they are, and are reported so, with Keep both,
        // unless they go elsewhere first.
        const rest = TransferReport.skip(result);
        setPending(TransferSession.pending(held.current()));
        if (rest.failed.length) setPhase({ kind: "failed", result: rest });
        else if (rest.transferred.length) onClose();
        else setPhase({ kind: "choosing" });
        return;
      }
      case "skip":
        held.update((session) => TransferSession.skip(session, result.clashes));
        settle(TransferReport.skip(result));
        return;
      case "keep-both":
      case "rename": {
        setPhase({ kind: "working" });
        const [only] = clashing;
        const retried = await transfer(
          clashing,
          result.destination,
          choice.kind === "keep-both"
            ? { clash: "keep-both" }
            : {
                clash: "refuse",
                names: new Map(only ? [[only.path, choice.name]] : []),
              },
        );
        settle(TransferReport.merge(result, retried));
      }
    }
  };

  const createFolder = async (name: string) => {
    if (browsed === null) return;
    setCreating({ kind: "naming", error: null, busy: true });
    try {
      const created = await trpcClient.files.createFolder.mutate({
        path: browsed || undefined,
        name,
      });
      void queryClient.invalidateQueries({ queryKey: ["files.list"] });
      go({ kind: "folder", path: created.path });
    } catch (error) {
      setCreating({
        kind: "naming",
        busy: false,
        error:
          error instanceof Error
            ? error.message
            : "The folder could not be created. Try again.",
      });
    }
  };

  const onPickerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.altKey &&
      event.key === "ArrowUp" &&
      browsed !== null &&
      !atRoot
    ) {
      event.preventDefault();
      // The folder just left is focused in its parent, as in a desktop file manager.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[role="listbox"]')
      )
        focusListAt(browsed);
      up();
    }
  };

  const verb = verbs[operation];
  const title = `${verb.title} ${subjectOf(pending)}`;
  const description =
    operation === "move"
      ? `Links, direct permissions and stars move with ${pending.length === 1 ? "it" : "them"}; access inherited from this folder is replaced by the destination's.`
      : "Copies get the destination's permissions, without links or direct permissions. A taken name gets a number.";

  const status = (() => {
    if (busy)
      return `The ${operation} goes on if you close this, and Nimbus reports when it is done.`;
    if (browsed === null) return "Choose a folder to open it.";
    if (capability.isError)
      return trpcErrorCode(capability.error) === "NOT_FOUND"
        ? "This folder no longer exists. Choose another."
        : `Nimbus could not check whether you can add items here: ${capability.error.message}`;
    if (!eligibility || !destination) return "Checking what you can do here…";
    if (eligibility.kind === "refused")
      return `${DropTarget.hint(eligibility, destination)}.`;
    const staying =
      operation === "move"
        ? DropTarget.alreadyThere(pending, destination)
        : null;
    return staying && `${staying}.`;
  })();
  const canSubmit =
    eligibility?.kind === operation &&
    !(browsed !== null && listing.isPlaceholderData) &&
    phase.kind !== "clashes" &&
    !busy &&
    pending.length > 0;
  const canCreate = destination !== null && destination.writable && !busy;

  const places: {
    key: string;
    label: string;
    icon: LucideIcon;
    active: boolean;
    open: () => void;
  }[] = [
    ...pinned.map((place) => ({
      key: `pinned:${place.path}`,
      label: place.label,
      icon: HardDrive,
      active: browsed === place.path,
      open: () => go({ kind: "folder", path: place.path }),
    })),
    {
      key: "files",
      label: DriveRoot.label,
      icon: HardDrive,
      active: browsed === top,
      open: () => go({ kind: "folder", path: top }),
    },
    {
      key: "starred",
      label: "Starred",
      icon: Star,
      active: view.kind === "starred",
      open: () => go({ kind: "starred" }),
    },
    {
      key: "recent",
      label: "Recent",
      icon: Clock,
      active: view.kind === "recent",
      open: () => go({ kind: "recent" }),
    },
  ];

  const openRow = (row: FolderRow) => {
    focusListAt(null);
    go({ kind: "folder", path: row.path });
  };

  const body = (() => {
    if (phase.kind === "clashes")
      return (
        <ClashPanel
          clashes={phase.result.clashes}
          place={nameOf(phase.result.destination)}
          busy={false}
          onChoose={(choice) => void resolve(phase.result, choice)}
        />
      );
    if (searched) {
      if (results.isError)
        return <Notice tone="error">{results.error.message}</Notice>;
      if (!results.data) return <Notice>Searching…</Notice>;
      const rows = results.data.entries
        .filter((entry) => withinTop(entry.path))
        .map((entry) =>
          rowFor({
            path: entry.path,
            name: entry.name,
            permission: entry.permission,
            detail: spelled(parentOf(entry.path), top),
          }),
        );
      return (
        <>
          {!results.data.complete && (
            <Notice>
              Nimbus is still indexing; some folders may be missing.
            </Notice>
          )}
          {rows.length ? (
            <FolderList
              rows={rows}
              label={`Folders matching ${searched}`}
              restoreKey={`picker-search:${searched}`}
              onOpen={openRow}
              stale={results.isPlaceholderData}
            />
          ) : (
            <Notice>No folder you can add to matches “{searched}”.</Notice>
          )}
        </>
      );
    }
    if (view.kind === "starred") {
      if (starred.isError)
        return <Notice tone="error">{starred.error.message}</Notice>;
      if (!starred.data) return <Notice>Loading starred folders…</Notice>;
      const rows = starred.data
        .filter(
          (entry) =>
            entry.starred &&
            entry.type === "dir" &&
            entry.permission !== "read" &&
            withinTop(entry.path),
        )
        .map((entry) =>
          rowFor({
            path: entry.path,
            name: entry.name,
            permission: entry.permission,
            detail: spelled(parentOf(entry.path), top),
          }),
        );
      return rows.length ? (
        <FolderList
          rows={rows}
          label="Starred folders"
          restoreKey="picker-starred"
          onOpen={openRow}
        />
      ) : (
        <Notice>
          No starred folders you can add to. Star a folder to find it here.
        </Notice>
      );
    }
    if (view.kind === "recent") {
      // Offered only once the server says the folder still takes items from this account.
      const rows = recentPaths.flatMap((path, index): FolderRow[] =>
        recentChecks[index]?.data?.permission === "write" ||
        recentChecks[index]?.data?.permission === "admin"
          ? [
              {
                path,
                name: nameOf(path),
                detail: path === top ? undefined : spelled(parentOf(path), top),
                eligibility: DropTarget.forItems(operation, pending, {
                  path,
                  writable: true,
                }),
              },
            ]
          : [],
      );
      if (!rows.length && recentChecks.some((check) => check.isPending))
        return <Notice>Checking recent folders…</Notice>;
      return rows.length ? (
        <FolderList
          rows={rows}
          label="Recent destinations"
          restoreKey="picker-recent"
          onOpen={openRow}
        />
      ) : (
        <Notice>Folders you move or copy items into show up here.</Notice>
      );
    }
    if (listing.isError)
      return (
        <Notice tone="error">
          {trpcErrorCode(listing.error) === "NOT_FOUND"
            ? "This folder no longer exists."
            : listing.error.message}{" "}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => go({ kind: "folder", path: top })}
          >
            Go to {DriveRoot.label}
          </button>
        </Notice>
      );
    if (!listing.data) return <Notice>Loading folders…</Notice>;
    return folderRows.length ? (
      <FolderList
        rows={folderRows}
        label={`Folders in ${nameOf(view.path)}`}
        restoreKey={`picker:${view.path}`}
        onOpen={openRow}
        focusRequest={listing.isPlaceholderData ? undefined : focusRequest}
        stale={listing.isPlaceholderData}
      />
    ) : (
      <Notice>No folders here.</Notice>
    );
  })();

  const content = (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onPickerKeyDown}>
      <div className="space-y-3 border-b px-4 pt-4 pb-3 sm:px-5">
        <div className="space-y-1 pr-8">
          <DialogTitle className="truncate text-lg leading-tight font-semibold">
            {title}
          </DialogTitle>
          <DialogDescription className="text-pretty text-sm text-muted-foreground max-sm:sr-only">
            {description}
          </DialogDescription>
        </div>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search destination folders"
            placeholder="Search destination folders…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                event.currentTarget
                  .closest("[data-picker]")
                  ?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')
                  ?.focus();
              }
            }}
            className="h-10 pl-9"
          />
        </div>
        {/* Phones show the places as a row of buttons above the list. */}
        <nav
          aria-label="Places"
          className="-mx-1 flex gap-1 overflow-x-auto px-1 sm:hidden"
        >
          {places.map((place) => (
            <Button
              key={place.key}
              variant={place.active ? "secondary" : "ghost"}
              size="compact"
              aria-current={place.active ? "page" : undefined}
              onClick={place.open}
              leadingIcon={place.icon}
              className="touch-hit shrink-0"
            >
              {place.label}
            </Button>
          ))}
        </nav>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Places"
          className="hidden w-44 shrink-0 flex-col gap-0.5 border-r p-2 sm:flex"
        >
          {places.map((place) => (
            <Button
              key={place.key}
              variant={place.active ? "secondary" : "ghost"}
              aria-current={place.active ? "page" : undefined}
              onClick={place.open}
              leadingIcon={place.icon}
              className="justify-start"
            >
              <span className="truncate">{place.label}</span>
            </Button>
          ))}
        </nav>
        <section
          aria-label="Destination"
          className="flex min-w-0 flex-1 flex-col"
        >
          <div className="flex items-center gap-1 border-b px-2 py-1.5">
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label="Back"
              disabled={history.length === 0 || busy}
              onClick={back}
              className="touch-hit"
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-compact"
              ref={upRef}
              aria-label="Up one folder"
              aria-keyshortcuts="Alt+ArrowUp"
              disabled={atRoot || busy}
              onClick={up}
              className="touch-hit"
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <div className="min-w-0 flex-1 px-1">
              <PathCrumbs
                view={view}
                top={top}
                onOpen={(path) => go({ kind: "folder", path })}
              />
            </div>
            <Button
              variant="ghost"
              size="compact"
              disabled={!canCreate}
              onClick={() =>
                setCreating({ kind: "naming", error: null, busy: false })
              }
              className="touch-hit shrink-0 gap-1.5"
              leadingIcon={FolderPlus}
            >
              <span className="max-sm:sr-only">New folder</span>
            </Button>
          </div>
          {creating.kind === "naming" && (
            <NewFolderForm
              busy={creating.busy}
              error={creating.error}
              onCancel={() => setCreating({ kind: "closed" })}
              onCreate={(name) => void createFolder(name)}
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {phase.kind === "failed" && (
              <FailurePanel
                result={phase.result}
                place={nameOf(phase.result.destination)}
                busy={busy}
                onRetry={() => {
                  if (!busy) void submitTo(phase.result.destination);
                }}
                onUndo={() => undoFromPicker(phase.result)}
              />
            )}
            <div className="p-2">{body}</div>
          </div>
        </section>
      </div>
      <div className="space-y-2 border-t px-4 py-3 sm:px-5">
        <p
          className="truncate text-sm"
          title={browsed === null ? undefined : spelled(browsed, top)}
        >
          <span className="text-muted-foreground">Destination: </span>
          {browsed === null ? "None chosen" : spelled(browsed, top)}
        </p>
        {status && (
          <p
            role="status"
            className="text-pretty text-sm text-muted-foreground"
          >
            {status}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="tertiary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            ref={submitRef}
            disabled={!canSubmit}
            onClick={submit}
            aria-label={
              busy || browsed === null
                ? undefined
                : `${verb.title} to “${nameOf(browsed)}”`
            }
            // The button keeps its label on one line and never narrower than it; its label's
            // layers may shrink here so the folder's name can shorten instead.
            className="min-w-0 max-w-full sm:max-w-96 [&>span:last-child]:min-w-0 [&>span:last-child]:max-w-full [&>span:last-child>span]:min-w-0 [&>span:last-child>span]:overflow-hidden"
          >
            {busy ? (
              verb.working
            ) : browsed === null ? (
              verb.title
            ) : (
              // The folder's name shortens; the verb and the quotes stay.
              <span className="flex min-w-0">
                {verb.title} to “
                <span className="min-w-0 truncate">{nameOf(browsed)}</span>”
              </span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );

  // Closing while a transfer runs leaves it running; its report follows when it finishes.
  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
  // A full-height sheet on phones: their dialog, centred and as large as the visible viewport,
  // which the on-screen keyboard shrinks.
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        data-picker=""
        size="lg"
        className={
          mobile
            ? "flex h-dvh max-h-dvh w-full max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
            : "flex h-[min(560px,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-[760px] flex-col gap-0 overflow-hidden p-0"
        }
        style={
          viewport
            ? {
                top: viewport.top + viewport.height / 2,
                height: viewport.height,
              }
            : undefined
        }
      >
        {content}
        <WhenDialogClosed onClosed={returnFocus} />
      </DialogContent>
    </Dialog>
  );
}

function Notice({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "text-pretty px-3 py-6 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/** Where the picker is, each folder above it a button that opens it. Middle folders collapse. */
function PathCrumbs({
  view,
  top,
  onOpen,
}: {
  view: View;
  /** The account's top folder, where the trail starts when the folder is inside it. */
  top: string;
  onOpen: (path: string) => void;
}) {
  if (view.kind !== "folder")
    return (
      <p className="truncate text-sm font-medium">
        {view.kind === "starred" ? "Starred" : "Recent"}
      </p>
    );
  const trail = BreadcrumbTrail.of(view.path, top, DriveRoot.label);
  const crumbs = [trail.root, ...trail.crumbs];
  // Wide screens keep the root, the parent and the current folder, folding what lies between.
  // Phones keep the root and the current folder: a long parent would push the current out.
  type Item =
    | {
        kind: "crumb";
        crumb: (typeof crumbs)[number];
        last: boolean;
        hide: string;
      }
    | { kind: "folded"; hide: string };
  const items: Item[] = crumbs.flatMap((crumb, index): Item[] => {
    const last = index === crumbs.length - 1;
    if (index === 0 || last) return [{ kind: "crumb", crumb, last, hide: "" }];
    const parent = index === crumbs.length - 2;
    const folded: Item[] =
      index === 1
        ? [{ kind: "folded", hide: crumbs.length > 3 ? "" : "sm:hidden" }]
        : [];
    return parent
      ? [...folded, { kind: "crumb", crumb, last, hide: "max-sm:hidden" }]
      : folded;
  });
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="min-w-0 flex-nowrap gap-1 overflow-hidden text-sm sm:gap-1.5">
        {items.map((item, index) => (
          <Fragment
            key={item.kind === "crumb" ? item.crumb.path || "/" : "folded"}
          >
            {index > 0 && <BreadcrumbSeparator className={item.hide} />}
            <BreadcrumbItem
              className={cn(
                item.kind === "crumb" && item.last ? "min-w-0" : "shrink-0",
                item.hide,
              )}
            >
              {item.kind === "folded" ? (
                <span aria-hidden="true" className="px-0.5">
                  …
                </span>
              ) : item.last ? (
                <BreadcrumbPage
                  className="truncate font-medium"
                  title={item.crumb.label}
                >
                  {item.crumb.label}
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink
                  render={<button type="button" />}
                  title={item.crumb.label}
                  onClick={() => onOpen(item.crumb.path)}
                  className="max-w-40 truncate"
                >
                  {item.crumb.label}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function NewFolderForm({
  busy,
  error,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  return (
    <form
      className="space-y-2 border-b p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onCreate(trimmed);
      }}
    >
      <div className="flex gap-2">
        <Input
          aria-label="New folder name"
          placeholder="Folder name"
          autoFocus
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }}
          className="min-w-0"
        />
        <Button type="submit" disabled={busy || !trimmed}>
          Create
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export default DestinationPicker;
