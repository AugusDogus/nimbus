/**
 * Bounded reads of request bodies. Bun.serve accepts bodies of any size so uploads can stream
 * to disk, so every endpoint that buffers a body must cap it itself, before it is in memory.
 */
export type RequestBody =
  | { kind: "read"; bytes: Uint8Array }
  | { kind: "too_large"; maxBytes: number };

const formatBytes = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${Math.round(bytes / 1024)} KB`;

/**
 * Read at most `maxBytes` of the body. A declared Content-Length over the cap is refused before
 * any byte is read; a longer streamed body is cancelled as soon as it passes the cap.
 */
async function read(request: Request, maxBytes: number): Promise<RequestBody> {
  const tooLarge = { kind: "too_large", maxBytes } as const;
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return tooLarge;
  }
  const reader = request.body?.getReader();
  if (!reader) return { kind: "read", bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (
    let chunk = await reader.read();
    !chunk.done;
    chunk = await reader.read()
  ) {
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLarge;
    }
    chunks.push(chunk.value);
  }
  return { kind: "read", bytes: Buffer.concat(chunks) };
}

/** The 413 sent when a body passes its cap. Nothing in the request was acted on. */
function tooLargeResponse(maxBytes: number) {
  return Response.json(
    {
      error: `The request body is larger than this endpoint accepts (${formatBytes(maxBytes)}). Nothing was changed. Send a smaller request.`,
    },
    {
      status: 413,
      headers: { "Cache-Control": "no-store", Connection: "close" },
    },
  );
}

/**
 * The request with its body read into memory under the cap, for handlers that parse the body
 * themselves (tRPC, Better Auth), or the 413 to send instead.
 */
async function buffered(
  request: Request,
  maxBytes: number,
): Promise<
  { kind: "ok"; request: Request } | { kind: "too_large"; response: Response }
> {
  if (!request.body) return { kind: "ok", request };
  const body = await read(request, maxBytes);
  if (body.kind === "too_large")
    return { kind: "too_large", response: tooLargeResponse(maxBytes) };
  return { kind: "ok", request: new Request(request, { body: body.bytes }) };
}

/** Wrap a request handler so its body is capped before the handler runs. */
function capped<A extends unknown[]>(
  maxBytes: number,
  handler: (request: Request, ...rest: A) => Response | Promise<Response>,
) {
  return async (request: Request, ...rest: A) => {
    const limited = await buffered(request, maxBytes);
    return limited.kind === "ok"
      ? handler(limited.request, ...rest)
      : limited.response;
  };
}

export const RequestBody = {
  read,
  buffered,
  capped,
  tooLargeResponse,
  /** Small JSON forms, such as a link password. */
  smallJsonBytes: 4 * 1024,
} as const;
