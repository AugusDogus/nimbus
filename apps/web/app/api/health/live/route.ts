/** Liveness: the HTTP server and Next handler respond. Touches no storage. */
export function GET() {
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
