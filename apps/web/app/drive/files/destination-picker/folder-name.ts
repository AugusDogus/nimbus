import { DriveRoot } from "@nimbus/api/drive-root";

/**
 * A folder's name as people see it: Files for the account's top folder, which the breadcrumb
 * and the sidebar call by that label, and for the drive root; its own name for any other.
 * Used by the picker and by reports, which load on demand.
 */
export const folderName = (folder: string, top: string) =>
  folder === top || folder === ""
    ? DriveRoot.label
    : (folder.split("/").pop() ?? folder);
