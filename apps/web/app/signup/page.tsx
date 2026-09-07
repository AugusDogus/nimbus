import { db } from "@/server/db";
import { user } from "@/server/db/schema";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { NimbusLogo } from "@/components/nimbus-logo";
import { NimbusWordmark } from "@/components/nimbus-wordmark";
import Link from "next/link";

import { SignupForm } from "@/components/signup-form";

export default async function SignupPage() {
  await connection();
  const [existing] = await db.select({ id: user.id }).from(user).limit(1);
  if (existing) redirect("/login");
  return (
    <div className="bg-muted flex min-h-dvh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Link
          href="/"
          className="flex items-center gap-2 self-center font-medium"
        >
          <NimbusLogo className="size-8" />
          <NimbusWordmark />
        </Link>
        <SignupForm />
      </div>
    </div>
  );
}
