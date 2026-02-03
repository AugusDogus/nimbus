"use client";

import { Cloud } from "lucide-react";
import Link from "next/link";

import { signOut, useSession } from "@/lib/auth-client";

export default function Home() {
  const { data, isPending } = useSession();
  const email = data?.user?.email ?? "Signed in";

  return (
    <div className="min-h-dvh bg-zinc-50 px-6 py-12 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex w-full max-w-xl flex-col gap-8">
        <header className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            <span className="flex size-6 items-center justify-center rounded-md bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
              <Cloud className="size-4" />
            </span>
            Nimbus
          </div>
          <h1 className="text-balance text-3xl font-semibold">
            Welcome back
          </h1>
          <p className="text-pretty text-base text-zinc-600 dark:text-zinc-400">
            Sign in to access your account and test the Better Auth session
            wiring.
          </p>
        </header>

        <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          {isPending ? (
            <div className="space-y-3" aria-live="polite">
              <div className="h-5 w-40 rounded bg-zinc-100 dark:bg-zinc-900" />
              <div className="h-4 w-64 rounded bg-zinc-100 dark:bg-zinc-900" />
            </div>
          ) : data ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  Active session
                </p>
                <p className="text-pretty text-base">{email}</p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Link
                  className="inline-flex h-10 items-center justify-center rounded-md border border-zinc-200 px-4 text-sm font-medium text-zinc-900 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-900"
                  href="/files"
                >
                  Open files
                </Link>
                <button
                  className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                  type="button"
                  onClick={() => signOut()}
                >
                  Sign out
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-pretty text-base text-zinc-600 dark:text-zinc-400">
                You are not signed in yet.
              </p>
              <Link
                className="inline-flex h-10 items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
                href="/login"
              >
                Sign in
              </Link>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
