import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** One part of a report: a summary line, and the items it is about, one line each. */
export type DetailSection = { summary: string; items: readonly string[] };

function Details({
  title,
  sections,
  onClosed,
}: {
  title: string;
  sections: readonly DetailSection[];
  onClosed: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClosed();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60dvh] space-y-4 overflow-y-auto">
          {sections.map((section, index) => (
            <section key={index} className="space-y-1">
              <p className="text-pretty text-sm font-medium">
                {section.summary}
              </p>
              {section.items.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-pretty text-sm text-muted-foreground">
                  {section.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{item}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Show the whole of a report that a toast can only summarise, in a dialog of its own. It is
 * opened from a toast, outside any page, so it renders apart from the app and is removed again
 * once closed, which the returned promise waits for; focus returns to the toast.
 */
function open(title: string, sections: readonly DetailSection[]) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return new Promise<void>((resolve) =>
    root.render(
      <Details
        title={title}
        sections={sections}
        onClosed={() => {
          root.unmount();
          host.remove();
          resolve();
        }}
      />,
    ),
  );
}

export const TransferDetails = { open } as const;
