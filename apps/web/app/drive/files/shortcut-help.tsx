import { useSyncExternalStore } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const macSnapshot = () => /Mac|iPhone|iPad/.test(navigator.userAgent);
const subscribe = () => () => {};

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/** Keyboard shortcuts for the file collection. Opened with `?` while an entry has focus. */
export function ShortcutHelp({
  open,
  onOpenChange,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Return focus to the entry that opened the sheet; it has no trigger button to return to. */
  onClosed: () => void;
}) {
  const mac = useSyncExternalStore(subscribe, macSnapshot, () => false);
  const mod = mac ? "⌘" : "Ctrl";
  const shortcuts: { label: string; keys: string[] }[] = [
    { label: "Move between items", keys: ["↑", "↓", "←", "→"] },
    { label: "First or last item", keys: ["Home", "End"] },
    { label: "Move a page", keys: ["Page Up", "Page Down"] },
    { label: "Extend the selection", keys: ["Shift", "Arrow"] },
    { label: "Move without selecting", keys: [mod, "Arrow"] },
    { label: "Add or remove from selection", keys: ["Ctrl", "Space"] },
    { label: "Select all", keys: [mod, "A"] },
    { label: "Clear the selection", keys: ["Esc"] },
    { label: "Open", keys: ["Enter"] },
    { label: "Preview a file", keys: ["Space"] },
    { label: "Rename", keys: ["F2"] },
    { label: "Move to trash", keys: mac ? ["⌘", "Delete"] : ["Delete"] },
    { label: "Jump to a name", keys: ["Type its first letters"] },
    { label: "Show these shortcuts", keys: ["?"] },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        finalFocus={() => {
          onClosed();
          return false;
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            These work while a file or folder has focus.
          </DialogDescription>
        </DialogHeader>
        <dl className="divide-y text-sm">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.label}
              className="flex items-center justify-between gap-4 py-2"
            >
              <dt className="text-pretty">{shortcut.label}</dt>
              <dd>
                <Keys keys={shortcut.keys} />
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
