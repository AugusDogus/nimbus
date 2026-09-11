"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import {
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
import { FileEntry } from "./types";
import type { EntryDialog } from "./entry-dialogs";
import type { useFileActions } from "./use-file-actions";

export function EntryMenu({
  entry,
  children,
  actions,
  onSelect,
}: {
  entry: FileEntry;
  children: ReactNode;
  actions: ReturnType<typeof useFileActions>;
  onSelect: (dialog: EntryDialog) => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const items = [
    ...(entry.type === "dir"
      ? []
      : [
          {
            label: "Preview",
            icon: Eye,
            select: () => onSelect({ action: "preview", entry }),
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
            select: () => onSelect({ action: "share", entry }),
          },
        ]
      : []),
    ...(FileEntry.canMove(entry)
      ? [
          {
            label: "Rename",
            icon: Pencil,
            select: () => onSelect({ action: "rename", entry }),
          },
          {
            label: "Move",
            icon: FolderInput,
            select: () => onSelect({ action: "move", entry }),
          },
        ]
      : []),
    ...(entry.permission !== "read"
      ? [
          {
            label: "Move to trash",
            icon: Trash2,
            select: () => onSelect({ action: "delete", entry }),
          },
        ]
      : []),
  ];
  const trigger = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Actions for ${entry.name}`}
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
    <div className="group/entry relative">
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
                variant={
                  item.label === "Move to trash" ? "destructive" : "default"
                }
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
  );
  if (isMobile)
    return (
      <>
        {content}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle className="break-words text-balance">
                {entry.name}
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
    <ContextMenu>
      <ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
      <ContextMenuContent>
        {items.map((item) => (
          <ContextMenuItem
            key={item.label}
            variant={item.label === "Move to trash" ? "destructive" : "default"}
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
