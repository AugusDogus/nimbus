import type { Permission } from "@nimbus/api/drive-store";

export type FileEntry = {
  name: string;
  permission: Permission;
  path: string;
  type: string;
  mtime: number | null;
  size: number | null;
};

export const fileHref = (path: string) =>
  path ? `/browse/${path.split("/").map(encodeURIComponent).join("/")}` : "/";
