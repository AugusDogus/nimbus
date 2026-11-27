import { lazyComponent } from "@/components/lazy-component";

export type EntryIconProps = {
  type: string;
  name: string;
  /** Size and placement; theme images and Nimbus's own icons share it. */
  className: string;
  /**
   * The icon set to draw from: a manifest URL, or null for Nimbus's own icons, as settings
   * previews show them. Entries leave it out to use the account's set.
   */
  manifest?: string | null;
};

/**
 * An entry's icon. File pages carry only this slot: the code that resolves names against an icon
 * theme and draws Nimbus's own icons (file-icon-theme.tsx) loads beside the page, and the slot,
 * whose box the row or card already sizes, stays empty until it arrives.
 */
export const EntryIcon = lazyComponent<EntryIconProps>(async () => ({
  default: (await import("./file-icon-theme")).EntryIcon,
}));
