import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Check } from "lucide-react";
import { McpScope } from "@nimbus/api/mcp-scope";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { loadConsent, optionalScopeFields } from "@/server/mcp/oauth/authorization";
import { mcpRuntime } from "@/server/mcp/runtime";
import { getSession } from "@/server/files-data";

export const metadata: Metadata = { title: "Connect an app · Nimbus", robots: { index: false } };

type SearchParams = Record<string, string | string[] | undefined>;

const toSearchParams = (params: SearchParams) => {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) result.append(key, item);
  return result;
};

export default async function ConsentPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const runtime = mcpRuntime("html");
  if (runtime.kind === "unavailable") notFound();
  const view = await loadConsent(runtime.oauth, toSearchParams(await searchParams), await headers());
  if (view.kind === "sign_in") redirect(view.url);
  const session = await getSession();
  return (
    <div className="bg-muted flex min-h-dvh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link href="/" className="flex items-center gap-2 self-center font-medium">
          <NimbusLogo className="size-8" />
          <NimbusWordmark />
        </Link>
        <Card>
          {view.kind === "invalid" ? (
            <CardHeader className="text-center">
              <CardTitle role="heading" aria-level={1} className="text-balance text-xl">
                Can’t connect this app
              </CardTitle>
              <CardDescription role="alert" className="text-pretty">
                {view.message}
              </CardDescription>
            </CardHeader>
          ) : (
            <form method="post" action="/oauth/consent/decision" className="contents">
              <input type="hidden" name="ticket" value={view.ticket} />
              <CardHeader className="text-center">
                <CardTitle role="heading" aria-level={1} className="text-balance text-xl">
                  Connect {view.clientName}?
                </CardTitle>
                <CardDescription className="text-pretty">
                  It will work with your files as{" "}
                  <span className="font-medium text-foreground">{session?.user.email ?? "you"}</span>, with no more
                  access than your account has. Continue only if you started this connection.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <fieldset className="space-y-3">
                  <legend className="sr-only">Permissions for {view.clientName}</legend>
                  {view.scopes.map((scope) => {
                    const field = optionalScopeFields[scope];
                    const { title, detail } = McpScope.describe(scope);
                    const text = (
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm font-medium">{title}</span>
                        <span className="block text-pretty text-sm text-muted-foreground">{detail}</span>
                      </span>
                    );
                    return field === undefined ? (
                      <div key={scope} className="flex items-start gap-3 rounded-xl border border-border/60 p-3">
                        <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
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
                  <Button type="submit" name="decision" value="deny" variant="outline">
                    Cancel
                  </Button>
                  <Button type="submit" name="decision" value="approve">
                    Connect
                  </Button>
                </div>
                <p className="text-pretty text-center text-xs text-muted-foreground">
                  You’ll return to <span className="font-mono">{view.redirectTarget}</span>. Disconnect it any time in
                  Settings → MCP.
                </p>
              </CardFooter>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
