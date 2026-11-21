/** What the account's top folder is called wherever Nimbus names it. */
export const FILES_ROOT_LABEL = "Files";

/** A folder's name as Nimbus shows it: its last segment, or the root's label. */
export const folderLabel = (path: string) =>
  path ? (path.split("/").at(-1) ?? path) : FILES_ROOT_LABEL;
