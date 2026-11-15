"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import {
  Copy,
  Download,
  EllipsisVertical,
  Eye,
  FolderInput,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { DrawerActionItem } from "@/components/drawer-action-item";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { FileEntry } from "./types";
import type { EntryDialog } from "./entry-dialogs";
import type { useFileActions } from "./use-file-actions";

type MenuItem = {
  label: string;
  icon: typeof Eye;
  destructive?: boolean;
  select: () => void;
};

const capabilityCache = new WeakMap<readonly FileEntry[], { move: boolean; trash: boolean }>();
/**
 * Whether every target can be moved or trashed. Every mounted row shares the selection array, so
 * the answer is computed once per selection, not once per row over up to 50,000 entries.
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
      { label: `Download ${count} items`, icon: Download, select: () => actions.downloadEntries(targets) },
      { label: "Toggle star", icon: Star, select: () => void actions.starEntries(targets) },
      { label: "Copy to…", icon: Copy, select: () => open({ action: "copy", entries: targets }) },
      ...(can.move
        ? [{ label: "Move to…", icon: FolderInput, select: () => open({ action: "move", entries: targets }) }]
        : []),
      ...(can.trash
        ? [{ label: "Move to trash", icon: Trash2, destructive: true, select: () => open({ action: "delete", entries: targets }) }]
        : []),
    ];
  }
  return [
    ...(entry.type === "dir"
      ? []
      : [{ label: "Preview", icon: Eye, select: () => open({ action: "preview", entry }) }]),
    {
      label: entry.type === "dir" ? "Download ZIP" : "Download",
      icon: Download,
      select: () => actions.downloadFile(entry.path, entry.type === "dir"),
    },
    { label: "Toggle star", icon: Star, select: () => void actions.toggleStar(entry.path) },
    ...(entry.permission === "admin"
      ? [{ label: "Share", icon: Share2, select: () => open({ action: "share", entry }) }]
      : []),
    { label: "Copy to…", icon: Copy, select: () => open({ action: "copy", entries: [entry] }) },
    ...(FileEntry.canMove(entry)
      ? [
          { label: "Rename", icon: Pencil, select: () => open({ action: "rename", entry }) },
          { label: "Move", icon: FolderInput, select: () => open({ action: "move", entries: [entry] }) },
        ]
      : []),
    ...(entry.permission !== "read"
      ? [{ label: "Move to trash", icon: Trash2, destructive: true, select: () => open({ action: "delete", entries: [entry] }) }]
      : []),
  ];
}

export function EntryMenu({
  entry,
  targets,
  children,
  actions,
  onSelect,
  rowProps,
  tabbable,
  onContextMenu,
}: {
  entry: FileEntry;
  targets: readonly FileEntry[];
  children: ReactNode;
  actions: ReturnType<typeof useFileActions>;
  onSelect: (dialog: EntryDialog) => void;
  /** Semantics, position, and data attributes for the row element that wraps the entry. */
  rowProps: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | boolean | undefined>;
  /** The actions button joins the tab order only for the roving tab stop. */
  tabbable: boolean;
  /** Runs before the context menu opens, so right-clicking can adjust the selection. */
  onContextMenu: () => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const items = entryMenuItems(entry, targets, actions, onSelect);
  const label = targets.length > 1 ? `Actions for ${targets.length.toLocaleString()} selected items` : `Actions for ${entry.name}`;
  const trigger = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      tabIndex={tabbable ? 0 : -1}
      className="absolute right-2 top-2 shrink-0 text-muted-foreground md:opacity-0 md:group-hover/entry:opacity-100 md:group-focus-within/entry:opacity-100 md:data-[state=open]:opacity-100"
      onClick={(event) => {
        event.stopPropagation();
        if (isMobile) setOpen(true);
      }}
    >
      <EllipsisVertical className="size-4" />
    </Button>
  );
  const content = (
    <div {...rowProps} className={cn("group/entry relative", rowProps.className)}>
      <div role="gridcell">
        {children}
        {isMobile ? (
          trigger
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {items.map((item) => (
                <DropdownMenuItem
                  key={item.label}
                  variant={item.destructive ? "destructive" : "default"}
                  onSelect={item.select}
                >
                  <item.icon />
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
  if (isMobile)
    return (
      <>
        {content}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle className="break-words text-balance">
                {targets.length > 1 ? `${targets.length.toLocaleString()} selected items` : entry.name}
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
      </>
    );
  return (
    <ContextMenu
      onOpenChange={(next) => {
        if (next) onContextMenu();
      }}
    >
      <ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
      <ContextMenuContent>
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
    </ContextMenu>
  );
}
