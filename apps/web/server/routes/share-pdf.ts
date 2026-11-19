import { sharePdf } from "@/server/routes/files-pdf";

type Context = { params: Promise<{ token: string }> };

/** A public link's PDF pages, under its endpoint so they receive its unlock and transfer cookies. */
export async function GET(request: Request, context: Context) {
  const { token } = await context.params;
  return sharePdf(request, token);
}
