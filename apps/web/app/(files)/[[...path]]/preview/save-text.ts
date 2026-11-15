export type SaveOutcome =
  | { type: "saved"; etag: string; size: number }
  | { type: "conflict"; message: string }
  | { type: "failed"; message: string };

const errorMessage = (body: unknown) =>
  typeof body === "object" &&
  body !== null &&
  "error" in body &&
  typeof body.error === "string"
    ? body.error
    : null;

/** Write `text` only if the file still has the ETag the editor loaded. */
export async function saveText(
  path: string,
  etag: string,
  text: string,
): Promise<SaveOutcome> {
  let response: Response;
  try {
    response = await fetch(
      `/api/files/content?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: { "If-Match": etag, "Content-Type": "text/plain" },
        body: text,
      },
    );
  } catch {
    return {
      type: "failed",
      message:
        "Could not reach Nimbus. Your edits are still here and the file is unchanged. Check your connection and save again.",
    };
  }
  const body: unknown = await response.json().catch(() => null);
  const saved = response.headers.get("etag");
  if (response.ok && saved)
    return {
      type: "saved",
      etag: saved,
      size: new TextEncoder().encode(text).byteLength,
    };
  const message =
    errorMessage(body) ??
    "Saving failed. Your edits are still here and the file is unchanged. Try again.";
  return response.status === 412
    ? { type: "conflict", message }
    : { type: "failed", message };
}
