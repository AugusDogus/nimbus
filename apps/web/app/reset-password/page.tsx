import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import { mailConfig } from "@/server/mail";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  if (mailConfig.kind === "disabled") redirect("/login");
  const { token, error } = await searchParams;
  return (
    <div className="bg-muted flex min-h-dvh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link href="/" className="flex items-center gap-2 self-center font-medium">
          <NimbusLogo className="size-8" />
          <NimbusWordmark />
        </Link>
        <ResetPasswordForm
          token={typeof token === "string" ? token : null}
          expired={error === "INVALID_TOKEN"}
        />
      </div>
    </div>
  );
}
