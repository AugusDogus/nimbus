import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthPage } from "@/app/auth/auth-page";
import { SignupForm } from "@/components/signup-form";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/signup")({
  // Registration is open only until the first account exists.
  beforeLoad: async ({ context }) => {
    const options = await context.queryClient.fetchQuery(
      trpc.signIn.options.queryOptions(),
    );
    if (!options.setupAvailable) throw redirect({ to: "/login" });
  },
  component: () => (
    <AuthPage>
      <SignupForm />
    </AuthPage>
  ),
});
