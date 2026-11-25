/**
 * What the reach guard (`guard.test.ts`) lets through, in one place. Each entry says why.
 *
 * Everywhere else, a line that hides a control by the window's width passes only with a reason
 * comment on it or the line above it, in the form `reach: <the other route>`, such as
 * `// reach: the sort drawer offers sort and grouping`.
 */

/** Files that may read the window's size or media queries: they answer those questions. */
export const deviceModules: readonly { path: string; reason: string }[] = [
  {
    path: "lib/device.ts",
    reason: "The Device module: the one place that asks about the device.",
  },
  // TODO(split view): add the split view's rule module here once it lands; it decides where a
  // split is offered and may read the window for it.
  {
    path: "lib/color-scheme.ts",
    reason: "Reads the system's colour scheme, which is not a device question.",
  },
  {
    path: "lib/theme-boot-script.ts",
    reason:
      "Reads the system's colour scheme before the page paints, which is not a device question.",
  },
];

/**
 * Code the guard does not read: Fluid Functionalism's components and hooks, which this app
 * composes around rather than edits.
 */
export const vendored: readonly { path: string; reason: string }[] = [
  {
    path: "components/ui/",
    reason: "Fluid Functionalism's components; compose around them.",
  },
  {
    path: "hooks/use-fluid-hover.ts",
    reason: "Fluid Functionalism's hover highlight; compose around it.",
  },
];

/**
 * Lines that break the rule today and are owned by other work, matched by file and the exact
 * text of the line. The guard fails once one no longer matches, so this list only shrinks.
 */
export const pending: readonly {
  path: string;
  line: string;
  reason: string;
}[] = [
  {
    path: "app/drive/files/folder-card.tsx",
    line: 'className={cn("flex shrink-0 items-center", !pane && "max-lg:hidden")}',
    reason:
      "Back and Up beside a split view: the split view's own rule replaces this gate.",
  },
  {
    path: "app/drive/files/split-toggle.tsx",
    line: 'className="touch-hit text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground max-lg:hidden"',
    reason: "The split toggle: the split view's own rule replaces this gate.",
  },
  {
    path: "app/drive/files/selection-bar.tsx",
    line: 'className={other ? "max-md:hidden" : undefined}',
    reason:
      "Select all and Star with a split open: the split view's own rule replaces this gate; item menus offer both meanwhile.",
  },
  {
    path: "app/drive/files/files-page-client.tsx",
    line: 'if (!matchMedia("(min-width: 1024px)").matches) return;',
    reason:
      "Preloads the split view's code where it can open: the split view's own rule replaces this check.",
  },
];
