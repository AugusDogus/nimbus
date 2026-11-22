import { Check } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { McpScope } from "@nimbus/api/mcp-scope";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auth } from "@/lib/auth";
import { themeBoot } from "@/lib/theme-boot-script";
import { AppShell } from "@/server/app-shell";
import {
  loadConsent,
  optionalScopeFields,
  type ConsentView,
} from "@/server/mcp/oauth/authorization";
import { mcpRuntime } from "@/server/mcp/runtime";
import { SameSiteRedirect } from "@/server/same-site-redirect";
import { SecurityHeaders, type SecurityMode } from "@/server/security-headers";

type ReadyView = Extract<ConsentView, { kind: "ready" | "invalid" }>;

function ConsentCard({ view, email }: { view: ReadyView; email?: string }) {
  return (
    <div className="bg-muted flex min-h-dvh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <a href="/" className="flex items-center gap-2 self-center font-medium">
          <NimbusLogo className="size-8" />
          <NimbusWordmark />
        </a>
        <Card>
          {view.kind === "invalid" ? (
            <CardHeader className="text-center">
              <CardTitle
                role="heading"
                aria-level={1}
                className="text-balance text-xl"
              >
                Can’t connect this app
              </CardTitle>
              <CardDescription role="alert" className="text-pretty">
                {view.message}
              </CardDescription>
            </CardHeader>
          ) : (
            <form
              method="post"
              action="/oauth/consent/decision"
              className="contents"
            >
              <input type="hidden" name="ticket" value={view.ticket} />
              <CardHeader className="text-center">
                <CardTitle
                  role="heading"
                  aria-level={1}
                  className="text-balance text-xl"
                >
                  Connect {view.clientName}?
                </CardTitle>
                <CardDescription className="text-pretty">
                  It will work with your files as{" "}
                  <span className="font-medium text-foreground">
                    {email ?? "you"}
                  </span>
                  , with no more access than your account has. Continue only if
                  you started this connection.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <fieldset className="space-y-3">
                  <legend className="sr-only">
                    Permissions for {view.clientName}
                  </legend>
                  {view.scopes.map((scope) => {
                    const field = optionalScopeFields[scope];
                    const { title, detail } = McpScope.describe(scope);
                    const text = (
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm font-medium">
                          {title}
                        </span>
                        <span className="block text-pretty text-sm text-muted-foreground">
                          {detail}
                        </span>
                      </span>
                    );
                    return field === undefined ? (
                      <div
                        key={scope}
                        className="flex items-start gap-3 rounded-xl border border-border/60 p-3"
                      >
                        <Check
                          className="mt-0.5 size-4 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        {text}
                      </div>
                    ) : (
                      <label
                        key={scope}
                        className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 p-3 transition-colors has-[:checked]:border-primary/40 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 motion-reduce:transition-none"
                      >
                        <input
                          type="checkbox"
                          name={field}
                          defaultChecked
                          className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none"
                        />
                        {text}
                      </label>
                    );
                  })}
                </fieldset>
              </CardContent>
              <CardFooter className="flex-col gap-3">
                <div className="grid w-full grid-cols-2 gap-3">
                  <Button
                    type="submit"
                    name="decision"
                    value="deny"
                    variant="outline"
                  >
                    Cancel
                  </Button>
                  <Button type="submit" name="decision" value="approve">
                    Connect
                  </Button>
                </div>
                <p className="text-pretty text-center text-xs text-muted-foreground">
                  You’ll return to{" "}
                  <span className="font-mono">{view.redirectTarget}</span>.
                  Disconnect it any time in Settings → MCP.
                </p>
              </CardFooter>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * GET /oauth/consent: a plain HTML form, rendered here so it needs no script and is never
 * framed. The decision endpoint checks the Origin, so the page sends its own origin with
 * form posts even though Nimbus otherwise sends no referrer.
 */
export async function GET(
  request: Request,
  shell: AppShell,
  mode: SecurityMode,
): Promise<Response> {
  const runtime = mcpRuntime("html");
  if (runtime.kind === "unavailable") return runtime.response();
  const view = await loadConsent(
    runtime.oauth,
    new URL(request.url).searchParams,
    request.headers,
  );
  if (view.kind === "sign_in") return SameSiteRedirect.response(view.url);
  const session =
    view.kind === "ready"
      ? await auth.api.getSession({ headers: request.headers })
      : null;
  const nonce = SecurityHeaders.nonce();
  const body = renderToStaticMarkup(
    <ConsentCard view={view} email={session?.user.email} />,
  );
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect an app · Nimbus</title><meta name="robots" content="noindex"><meta name="referrer" content="same-origin"><link rel="icon" href="/icon.svg" sizes="any" type="image/svg+xml">${await shell.stylesheets(nonce)}<style id="nimbus-custom-themes"></style><script nonce="${nonce}">${themeBoot}</script></head><body class="antialiased">${body}</body></html>`;
  const headers = new Headers(
    SecurityHeaders.document(nonce, mode, {
      // Only the form that redirects to a client lifts form-action; see DocumentPolicy.
      formRedirects: view.kind === "ready" ? "unrestricted" : "same-origin",
    }),
  );
  return AppShell.htmlResponse(request, html, headers);
}
