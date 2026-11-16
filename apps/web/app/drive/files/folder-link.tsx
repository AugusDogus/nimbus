import type { ComponentPropsWithRef } from "react";
import { Link } from "@/components/link";

type FolderLinkProps = Omit<ComponentPropsWithRef<"a">, "href"> & {
  /** The folder, relative to the drive root; "" is the root. */
  path: string;
  /** Whether hovering or focusing loads the folder ahead of a click. Default true. */
  preload?: false;
};

/** A link to a folder in the file browser. */
export function FolderLink({ path, ...props }: FolderLinkProps) {
  return path ? (
    <Link to="/browse/$" params={{ _splat: path }} {...props} />
  ) : (
    <Link to="/" {...props} />
  );
}
