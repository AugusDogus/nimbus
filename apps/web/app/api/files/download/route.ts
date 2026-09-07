import { type NextRequest, NextResponse } from "next/server";
import path from "node:path";

import { auth } from "@/lib/auth";
import { statPath } from "@nimbus/api/fs-utils";
import { resolveSafePath } from "@nimbus/api/safe-path";

export async function GET(req: NextRequest) {
  // Auth check
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get and validate path
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) {
    return NextResponse.json({ error: "Missing path parameter." }, { status: 400 });
  }

  let resolved: string;
  try {
    const safe = await resolveSafePath(filePath);
    resolved = safe.absolute;
  } catch {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }

  // Stat the file
  let fileStats: Awaited<ReturnType<typeof statPath>>;
  try {
    fileStats = await statPath(resolved);
  } catch {
    return NextResponse.json({ error: "File not found." }, { status: 404 });
  }

  if (!fileStats.isFile) {
    return NextResponse.json({ error: "Not a file." }, { status: 400 });
  }

  const fileName = path.basename(resolved);
  const ext = path.extname(fileName).toLowerCase();
  const contentType = getContentType(ext);

  // Stream the file using Bun's native file API
  const file = Bun.file(resolved);

  return new Response(file.stream(), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "Content-Length": String(fileStats.size),
    },
  });
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".xml": "application/xml",
  };
  return types[ext] ?? "application/octet-stream";
}
