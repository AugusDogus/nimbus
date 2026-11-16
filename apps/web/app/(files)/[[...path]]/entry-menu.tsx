"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import {
  Copy,
  Download,
  EllipsisVertical,
  Eye,
  FolderInput,
  History,
  Pencil,
  Share2,
  Star,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { DrawerActionItem } from "@/components/drawer-action-item";
import { FileEntry } from "./types";
import type { EntryDialog } from "./entry-dialogs";
import type { useFileActions } from "./use-file-actions";

type MenuItem = {
  label: string;
  icon: typeof Eye;
  destructive?: boolean;
  select: () => void;
};

/** The entry a menu was opened for, and what its actions apply to. */
export type EntryMenuTarget = {
  entry: FileEntry;
  targets: readonly FileEntry[];
};

const capabilityCache = new WeakMap<
  readonly FileEntry[],
  { move: boolean; trash: boolean }
>();
/**
 * Whether every target can be moved or trashed. Rows share the selection array, so the answer is
 * computed once per selection, not once per row over up to 50,000 entries.
 */
export function selectionCapabilities(targets: readonly FileEntry[]) {
  let capabilities = capabilityCache.get(targets);
  if (!capabilities) {
    capabilities = {
      move: targets.every(FileEntry.canMove),
      trash: targets.every((target) => target.permission !== "read"),
    };
    capabilityCache.set(targets, capabilities);
  }
  return capabilities;
}

/** Actions for one entry, or for every target when the entry is part of a multi-selection. */
export function entryMenuItems(
  entry: FileEntry,
  targets: readonly FileEntry[],
  actions: ReturnType<typeof useFileActions>,
  open: (dialog: EntryDialog) => void,
): MenuItem[] {
  if (targets.length > 1) {
    const count = targets.length.toLocaleString();
    const can = selectionCapabilities(targets);
    return [
      {
        label: `Download ${count} items`,
        icon: Download,
        select: () => actions.downloadEntries(targets),
      },
      {
        label: "Toggle star",
        icon: Star,
        select: () => void actions.starEntries(targets),
      },
      {
        label: "Copy to…",
        icon: Copy,
        select: () => open({ action: "copy", entries: targets }),
      },
      ...(can.move
        ? [
            {
              label: "Move to…",
              icon: FolderInput,
              select: () => open({ action: "move", entries: targets }),
            },
          ]
        : []),
      ...(can.trash
        ? [
            {
              label: "Move to trash",
              icon: Trash2,
              destructive: true,
              select: () => open({ action: "delete", entries: targets }),
            },
          ]
        : []),
    ];
  }
  return [
    ...(entry.type === "dir"
      ? []
      : [
          {
            label: "Preview",
            icon: Eye,
            select: () => open({ action: "preview", entry }),
          },
          {
            label: "Version history",
            icon: History,
            select: () => open({ action: "versions", entry }),
          },
        ]),
    {
      label: entry.type === "dir" ? "Download ZIP" : "Download",
      icon: Download,
      select: () => actions.downloadFile(entry.path, entry.type === "dir"),
    },
    {
      label: "Toggle star",
      icon: Star,
      select: () => void actions.toggleStar(entry.path),
    },
    ...(entry.permission === "admin"
      ? [
          {
            label: "Share",
            icon: Share2,
            select: () => open({ action: "share", entry }),
          },
        ]
      : []),
    {
      label: "Copy to…",
      icon: Copy,
      select: () => open({ action: "copy", entries: [entry] }),
    },
    ...(FileEntry.canMove(entry)
      ? [
          {
            label: "Rename",
            icon: Pencil,
            select: () => open({ action: "rename", entry }),
          },
          {
            label: "Move",
            icon: FolderInput,
            select: () => open({ action: "move", entries: [entry] }),
          },
        ]
      : []),
    ...(entry.permission !== "read"
      ? [
          {
            label: "Move to trash",
            icon: Trash2,
            destructive: true,
            select: () => open({ action: "delete", entries: [entry] }),
          },
        ]
      : []),
  ];
}

/**
 * The "more actions" button on each row. It holds no menu of its own: on desktop it opens the
 * collection's shared context menu at the button, on touch screens the shared drawer.
 */
export function EntryActionsButton({
  name,
  count,
  tabbable,
  open,
  onOpen,
}: {
  name: string;
  /** Entries the menu will act on: more than one when the row is part of a multi-selection. */
  count: number;
  tabbable: boolean;
  open: boolean;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={
        count > 1
          ? `Actions for ${count.toLocaleString()} selected items`
          : `Actions for ${name}`
      }
      aria-haspopup="menu"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      tabIndex={tabbable ? 0 : -1}
      className="absolute right-2 top-2 shrink-0 text-muted-foreground md:opacity-0 md:group-hover/entry:opacity-100 md:group-focus-within/entry:opacity-100 md:data-[state=open]:opacity-100"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event);
      }}
    >
      <EllipsisVertical className="size-4" />
    </Button>
  );
}

/** Open the shared context menu at a row's actions button, as a right-click there would. */
export function openMenuAt(button: HTMLElement) {
  const rect = button.getBoundingClientRect();
  button.dispatchEvent(
    new globalThis.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.right,
      clientY: rect.bottom,
    }),
  );
}

/**
 * One menu for the whole collection. Mounting a menu per row made scrolling large folders mount
 * menu machinery for every row that appeared. `resolve` maps the row under a right-click, a
 * Shift+F10 press, or an actions button to its menu target; null leaves no menu to show.
 */
export function EntryMenuHost({
  children,
  touch,
  menu,
  onMenuChange,
  resolve,
  actions,
  open,
  onClosed,
}: {
  children: ReactNode;
  touch: boolean;
  menu: EntryMenuTarget | null;
  onMenuChange: (menu: EntryMenuTarget | null) => void;
  resolve: (path: string) => EntryMenuTarget | null;
  actions: ReturnType<typeof useFileActions>;
  open: (dialog: EntryDialog) => void;
  /** Return focus to the entry after the menu closes. The grid itself cannot hold focus. */
  onClosed: () => void;
}) {
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const items = menu
    ? entryMenuItems(menu.entry, menu.targets, actions, open)
    : [];
  // The tree around `children` is the same in both modes. Swapping it when the mode changes, as it
  // does after hydration on phones, would replace every row's element, even under a finger.
  return (
    <ContextMenu
      onOpenChange={(next) => {
        if (!next) onMenuChange(null);
        setContextMenuOpen(next);
      }}
    >
      <ContextMenuTrigger
        asChild
        // Touch layouts long-press to select, and open actions in the drawer.
        disabled={touch}
        onContextMenu={(event) => {
          if (touch) return;
          const row =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-row-path]")
              : null;
          const target =
            row?.dataset.rowPath === undefined
              ? null
              : resolve(row.dataset.rowPath);
          // Empty space between entries has no actions.
          if (!target) {
            event.preventDefault();
            return;
          }
          onMenuChange(target);
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        {items.map((item) => (
          <ContextMenuItem
            key={item.label}
            variant={item.destructive ? "destructive" : "default"}
            onSelect={item.select}
          >
            <item.icon />
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
      {/* Only touch layouts open the drawer. Both menus stay mounted, so one that is open when the
          viewport crosses the breakpoint, as when a phone rotates, stays as it opened. */}
      <Drawer
        open={menu !== null && !contextMenuOpen}
        onOpenChange={(next) => !next && onMenuChange(null)}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="break-words text-balance">
              {menu && menu.targets.length > 1
                ? `${menu.targets.length.toLocaleString()} selected items`
                : menu?.entry.name}
            </DrawerTitle>
            <DrawerDescription>File actions</DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-6">
            {items.map((item) => (
              <DrawerClose asChild key={item.label}>
                <DrawerActionItem onClick={item.select}>
                  <item.icon className="size-5" />
                  {item.label}
                </DrawerActionItem>
              </DrawerClose>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </ContextMenu>
  );
}
