import { useContext, type ComponentPropsWithRef } from "react";
import { Link } from "@/components/link";
import { PaneLinks } from "./pane-links";

type FolderLinkProps = Omit<ComponentPropsWithRef<"a">, "href"> & {
  /** The folder, relative to the drive root; "" is the root. */
  path: string;
  /** Whether hovering or focusing loads the folder ahead of a click. Default true. */
  preload?: false;
};

/** A link to a folder in the file browser, opening in the pane it is in during a split view. */
export function FolderLink({ path, ...props }: FolderLinkProps) {
  const pane = useContext(PaneLinks);
  if (pane) {
    const { left, search } = pane.to(path);
    return left ? (
      <Link
        to="/browse/$"
        params={{ _splat: left }}
        search={search}
        {...props}
      />
    ) : (
      <Link to="/" search={search} {...props} />
    );
  }
  return path ? (
    <Link to="/browse/$" params={{ _splat: path }} {...props} />
  ) : (
    <Link to="/" {...props} />
  );
}
