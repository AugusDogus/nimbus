import { FileListing } from "@nimbus/api/file-listing";
import { trpcClient } from "./trpc";

/**
 * A folder's entries, fetched and decoded. The one place the browser turns the
 * columnar listing that `files.list` sends into entries, validating it first.
 */
export async function fetchFileList(path: string, includeStats: boolean) {
  const listing: unknown = await trpcClient.files.list.query(
    path ? { path, includeStats } : { includeStats },
  );
  const decoded = FileListing.decode(listing);
  // React Query shows a failed fetch as an error state with this message.
  if (!decoded.ok) throw new Error(decoded.error.message);
  return decoded.entries;
}
