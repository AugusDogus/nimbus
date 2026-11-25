import { cn } from "@/lib/utils";
import { TransferCode } from "./transfer-code";
import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import {
  Columns2,
  Copy,
  CornerLeftUp,
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
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuItem } from "@/components/ui/menu-item";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { DrawerActionItem } from "@/components/drawer-action-item";
import { starControl, useStarredPaths, type StarredPaths } from "./starred";
import { FileEntry } from "./types";
import type { EntryDialog } from "./entry-dialogs";
import { MoveUp } from "./move-up";
import type { useFileActions } from "./use-file-actions";
import { EntryShape } from "./entry-shape";

type MenuItem = {
  label: string;
  icon: typeof Eye;
  destructive?: boolean;
  /** Not yet usable, such as starring before the current stars have loaded. */
  disabled?: boolean;
  select: () => void;
};

/** The entry a menu was opened for, and what its actions apply to. */
export type EntryMenuTarget = {
  entry: FileEntry;
  targets: readonly FileEntry[];
};

/**
 * An open entry menu and where it shows: the menu at the pointer (a right-click, or the corner of an
 * actions button, see `openMenuAt`), or the drawer where the primary pointer is a finger. The surface
 * is fixed when the menu opens, so a menu that is open when the pointer changes stays as it opened.
 * A menu opened from the keyboard starts on its first item.
 */
export type EntryMenu = EntryMenuTarget & {
  surface: { kind: "menu"; keyboard: boolean } | { kind: "drawer" };
};

export const EntryMenu = {
  inDrawer(target: EntryMenuTarget): EntryMenu {
    return { ...target, surface: { kind: "drawer" } };
  },
  /**
   * A `contextmenu` from Shift+F10, the menu key, or a keyboard click on an actions button: a pointer
   * sends the secondary button (2), or a click count of 1 or more for an actions button.
   */
  fromKeyboard(event: globalThis.MouseEvent) {
    return event.button !== 2 && event.detail === 0;
  },
} as const;

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
      trash: targets.every(FileEntry.canTrash),
    };
    capabilityCache.set(targets, capabilities);
  }
  return capabilities;
}

/** Star or remove the stars of `targets`, labelled by what it will do (see `starControl`). */
function starItem(
  targets: readonly FileEntry[],
  starred: StarredPaths,
  actions: ReturnType<typeof useFileActions>,
): MenuItem {
  const control = starControl(targets, starred, actions.setStarred);
  return {
    label: control.label,
    icon: Star,
    disabled: control.disabled,
    select: control.run,
  };
}

/**
 * Move `targets` up into the folder above the one shown, without dragging: offered when they may
 * go there, and disabled in its place while that is not known (see `MoveUp`).
 */
const moveUpItems = (
  targets: readonly FileEntry[],
  actions: ReturnType<typeof useFileActions>,
  moveUp: MoveUp,
): MenuItem[] => {
  if (moveUp.kind === "none") return [];
  const into = moveUp.kind === "into" ? moveUp.path : null;
  return [
    {
      label: "Move up one level",
      icon: CornerLeftUp,
      disabled: into === null,
      select: () => {
        if (into !== null) void actions.moveEntries(targets, into);
      },
    },
  ];
};

/**
 * Actions for one entry, or for every target when the entry is part of a multi-selection.
 * `starred` is what is starred now. `moveUp` says whether items may move up into the folder
 * above the one shown. `openInOtherPane` opens a folder in the other pane of a split view, where
 * the page has one or can open one.
 */
export function entryMenuItems(
  entry: FileEntry,
  targets: readonly FileEntry[],
  actions: ReturnType<typeof useFileActions>,
  open: (dialog: EntryDialog) => void,
  starred: StarredPaths,
  moveUp: MoveUp,
  openInOtherPane: ((path: string) => void) | null,
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
      starItem(targets, starred, actions),
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
            ...moveUpItems(targets, actions, moveUp),
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
      ? openInOtherPane
        ? [
            {
              label: "Open in other pane",
              icon: Columns2,
              select: () => openInOtherPane(entry.path),
            },
          ]
        : []
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
    starItem([entry], starred, actions),
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
            label: "Move to…",
            icon: FolderInput,
            select: () => open({ action: "move", entries: [entry] }),
          },
          ...moveUpItems([entry], actions, moveUp),
        ]
      : []),
    ...(FileEntry.canTrash(entry)
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
 * collection's shared menu at the button, where the primary pointer is a finger the shared drawer.
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
      size="icon-compact"
      aria-label={
        count > 1
          ? `Actions for ${count.toLocaleString()} selected items`
          : `Actions for ${name}`
      }
      aria-haspopup="menu"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      tabIndex={tabbable ? 0 : -1}
      // Shown only on hover where there is a mouse; touch screens of every width keep it visible,
      // with a 44 px target centered where the smaller button sits.
      className={cn(
        EntryShape.actions,
        "text-muted-foreground md:pointer-fine:opacity-0 md:pointer-fine:group-hover/entry:opacity-100 md:pointer-fine:group-focus-within/entry:opacity-100 md:pointer-fine:data-[state=open]:opacity-100",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event);
      }}
    >
      <EllipsisVertical className="size-4" />
    </Button>
  );
}

/**
 * Open the shared menu at a row's actions button, as a right-click at its bottom-right corner would.
 * Base UI's context menu only arms outside-press dismissal and its pointer guards when its trigger
 * handles the opening `contextmenu` event, and it has no public way to open at a point.
 */
export function openMenuAt(click: MouseEvent<HTMLElement>) {
  const button = click.currentTarget;
  const rect = button.getBoundingClientRect();
  button.dispatchEvent(
    new globalThis.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.right,
      clientY: rect.bottom,
      // 0 for a click from Enter or Space, so the menu knows it was opened from the keyboard.
      detail: click.detail,
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
  menu,
  onMenuChange,
  resolve,
  actions,
  open,
  moveUp,
  openInOtherPane,
  onClosed,
}: {
  /** The collection's element. The right-click area is rendered onto it, not around it. */
  children: ReactElement<HTMLAttributes<HTMLElement>>;
  menu: EntryMenu | null;
  onMenuChange: (menu: EntryMenu | null) => void;
  resolve: (path: string) => EntryMenuTarget | null;
  actions: ReturnType<typeof useFileActions>;
  open: (dialog: EntryDialog) => void;
  /** Whether items may move up into the folder above the one shown (see `MoveUp`). */
  moveUp: MoveUp;
  /** Opens a folder in the other pane of a split view; null where the page offers no split. */
  openInOtherPane: ((path: string) => void) | null;
  /** Return focus to the entry after the menu closes. The grid itself cannot hold focus. */
  onClosed: () => void;
}) {
  // The last menu stays rendered while it animates closed, in place and with its items.
  const [shown, setShown] = useState(menu);
  // What Move up was when the menu opened: its items stay as they opened (see `MoveUp.steady`).
  const [moveUpAtOpen, setMoveUpAtOpen] = useState(moveUp);
  if (menu !== null && menu !== shown) {
    setShown(menu);
    setMoveUpAtOpen(moveUp);
  }
  const starred = useStarredPaths(menu !== null);
  // A menu may move items: what does so loads while the person chooses.
  useEffect(() => {
    if (menu !== null) TransferCode.prepare();
  }, [menu]);
  const items = shown
    ? entryMenuItems(
        shown.entry,
        shown.targets,
        actions,
        open,
        starred,
        MoveUp.steady(moveUpAtOpen, moveUp),
        openInOtherPane,
      )
    : [];
  const popup = useRef<HTMLDivElement>(null);
  // Fluid Functionalism's context menu keeps its own open state. When the menu is withdrawn from
  // outside, as when its entry leaves the folder, an Escape closes it the way a person would.
  const popupOpen = useRef(false);
  useEffect(() => {
    if (menu === null && popupOpen.current)
      popup.current?.dispatchEvent(
        new globalThis.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
  }, [menu]);
  /** The row a right-click, Shift+F10 or the menu key came from, as the menu's target. */
  const targetOf = (element: EventTarget) => {
    const row =
      element instanceof Element
        ? element.closest<HTMLElement>("[data-row-path]")
        : null;
    return row?.dataset.rowPath === undefined
      ? null
      : resolve(row.dataset.rowPath);
  };
  // The tree around `children` is the same in both modes. Swapping it when the mode changes would
  // replace every row's element, even under a finger.
  return (
    <ContextMenu
      // On every device: a finger's long-press selects instead (see `EntriesView`), while a
      // right-click, Shift+F10 and the menu key open the menu.
      onOpenChange={(next) => {
        popupOpen.current = next;
        if (next) return;
        onMenuChange(null);
        // The menu hands focus back a frame after it closes; the entry takes it after that, unless
        // the chosen action moved it somewhere, such as into a dialog.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const active = document.activeElement;
            if (
              active instanceof HTMLElement &&
              active.hasAttribute("data-context-menu-anchor")
            )
              active.blur();
            onClosed();
          }),
        );
      }}
    >
      <ContextMenuTrigger
        render={children}
        className="select-none"
        onContextMenu={(event) => {
          // A long-press that selected has claimed the event.
          if (event.defaultPrevented) return;
          const target = targetOf(event.target);
          // Empty space between entries has no actions, and the browser's own menu stays away.
          if (!target) {
            event.preventDefault();
            return;
          }
          onMenuChange({
            ...target,
            surface: {
              kind: "menu",
              keyboard: EntryMenu.fromKeyboard(event.nativeEvent),
            },
          });
        }}
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          // The menu opens on these keys itself, from the focused row.
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          )
            return;
          const target = targetOf(event.target);
          if (!target) {
            event.preventDefault();
            return;
          }
          onMenuChange({
            ...target,
            surface: { kind: "menu", keyboard: true },
          });
        }}
      />
      <ContextMenuContent ref={popup} className="w-56">
        {items.map((item, index) => (
          <MenuItem
            key={item.label}
            index={index}
            icon={item.icon}
            label={item.label}
            destructive={item.destructive}
            disabled={item.disabled}
            onSelect={item.select}
          />
        ))}
      </ContextMenuContent>
      <Drawer
        showSwipeHandle
        open={menu?.surface.kind === "drawer"}
        onOpenChange={(next) => !next && onMenuChange(null)}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="break-words text-balance">
              {shown && shown.targets.length > 1
                ? `${shown.targets.length.toLocaleString()} selected items`
                : shown?.entry.name}
            </DrawerTitle>
            <DrawerDescription>
              {shown && shown.targets.length > 1
                ? "Actions for every selected item"
                : shown?.entry.type === "dir"
                  ? "Folder actions"
                  : "File actions"}
            </DrawerDescription>
          </DrawerHeader>
          <div className="px-4 pb-6">
            {items.map((item) => (
              <DrawerClose
                key={item.label}
                render={
                  <DrawerActionItem
                    disabled={item.disabled}
                    onClick={item.select}
                  />
                }
              >
                <item.icon className="size-5" />
                {item.label}
              </DrawerClose>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </ContextMenu>
  );
}
