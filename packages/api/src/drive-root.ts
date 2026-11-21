/**
 * The drive root as people see it. One name for it everywhere: the sidebar, the breadcrumb,
 * dialogs, messages, archive names and tool descriptions.
 */
export const DriveRoot = {
  label: "Files",
  /** A folder's name as shown, the root's included: `a/b` is "b", "" is the root's label. */
  nameOf: (path: string) => path.split("/").pop() || DriveRoot.label,
} as const;
