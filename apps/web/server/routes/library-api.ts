import { LibraryHttp } from "@/server/libraries/library-http";
import { libraryRuntime } from "@/server/libraries/library-runtime";

type Params = { params: Promise<{ endpoint: string }> };

/** The library API, /api/library/v1/*: pairing, the paired device and its library. */
const handle = async (request: Request, { params }: Params) =>
  LibraryHttp.handle(libraryRuntime(), request, (await params).endpoint);

export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
