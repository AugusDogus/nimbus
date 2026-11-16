import { getDataRoot } from "@nimbus/api/data-root";
import { client } from "@/server/db";
import { Readiness } from "@/server/health";
import { getConfigRoot } from "@/server/storage-paths";

const readiness = Readiness.cached(
  () => ({
    query: async () => client.query("select 1").get(),
    dataRoot: getDataRoot(),
    configRoot: getConfigRoot(),
    timeoutMs: 2000,
  }),
  5000,
);
let reported = "";

/**
 * Readiness: the database answers and both storage roots accept writes.
 * Callers are unauthenticated, so the response carries no details; failures
 * are logged once per change of state for the operator.
 */
export async function GET() {
  const result = await readiness();
  const summary = result.failures
    .map((failure) => `${failure.check}: ${failure.reason}`)
    .join("; ");
  if (summary !== reported) {
    if (summary)
      console.error(
        `Nimbus readiness check failed (${summary}). Requests depending on these will fail until fixed; files and the database are not modified by this check. Verify the volume mounts and permissions.`,
      );
    else if (reported) console.info("Nimbus readiness check recovered.");
    reported = summary;
  }
  return Response.json(
    { status: result.ready ? "ready" : "unavailable" },
    {
      status: result.ready ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
