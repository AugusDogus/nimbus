import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthPage } from "@/app/auth/auth-page";
import { ResetPasswordForm } from "@/app/auth/reset-password-form";
import { SearchParams } from "@/client/search-params";
import { trpc } from "@/lib/trpc";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search): { token?: string; error?: string } => ({
    token: SearchParams.string(search, "token"),
    error: SearchParams.string(search, "error"),
  }),
  beforeLoad: async ({ context }) => {
    const options = await context.queryClient.fetchQuery(
      trpc.signIn.options.queryOptions(),
    );
    if (!options.passwordReset) throw redirect({ to: "/login" });
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token, error } = Route.useSearch();
  return (
    <AuthPage>
      <ResetPasswordForm
        token={token ?? null}
        expired={error === "INVALID_TOKEN"}
      />
    </AuthPage>
  );
}
