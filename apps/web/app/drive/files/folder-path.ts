import { useParams } from "@tanstack/react-router";

/** A folder's path relative to the drive root, as `a/b/c`; the root is "". */
export const FolderPath = {
  /** The folder named by the `/browse/*` part of the address. */
  fromSplat(splat: string | undefined): string {
    return (splat ?? "").split("/").filter(Boolean).join("/");
  },
} as const;

/** The folder the address names: the root on `/`, otherwise the `/browse/*` path. */
export function useFolderPath(): string {
  const params = useParams({ strict: false });
  return FolderPath.fromSplat(params._splat);
}
