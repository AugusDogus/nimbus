import { describe, expect, it } from "bun:test";
import { rewriteRouteModule } from "./route-chunk-recovery";

describe("rewriteRouteModule", () => {
  it("loads split route code through Nimbus's own lazyRouteComponent", () => {
    const code = `import { lazyRouteComponent } from '@tanstack/react-router';
const $$splitComponentImporter = () => import('./trash.tsx?tsr-split=component');
export const Route = createFileRoute('/trash')({ component: lazyRouteComponent($$splitComponentImporter, 'component') });`;
    const rewritten = rewriteRouteModule(
      code,
      "trash.tsx",
      "/app/lazy-route.ts",
    );
    expect(rewritten).toContain(
      'import { lazyRouteComponent } from "/app/lazy-route.ts";',
    );
    expect(rewritten).not.toContain("@tanstack/react-router");
  });

  it("leaves modules without split routes alone", () => {
    expect(rewriteRouteModule("export const x = 1;", "x.tsx", "/r.ts")).toBe(
      null,
    );
  });

  it("fails on a use it does not recognise", () => {
    expect(() =>
      rewriteRouteModule(
        "import { createFileRoute, lazyRouteComponent } from '@tanstack/react-router';",
        "odd.tsx",
        "/r.ts",
      ),
    ).toThrow("odd.tsx uses lazyRouteComponent");
  });
});
