import { shareThumbnail } from "@/server/routes/files-thumbnail";

type Context = { params: Promise<{ token: string }> };

/** Thumbnails of a public link's files, under its endpoint so they receive its unlock cookie. */
export async function GET(request: Request, context: Context) {
  const { token } = await context.params;
  return shareThumbnail(request, token);
}
