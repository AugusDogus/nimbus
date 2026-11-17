import type { ReactNode } from "react";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";

/** The centered card layout of the sign-in, sign-up and password reset pages. */
export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="bg-muted flex min-h-dvh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <a href="/" className="flex items-center gap-2 self-center font-medium">
          <NimbusLogo className="size-8" />
          <NimbusWordmark />
        </a>
        {children}
      </div>
    </div>
  );
}
