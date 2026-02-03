"use client";

import { useQuery } from "@tanstack/react-query";
import { Cloud } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { signOut, useSession } from "@/lib/auth-client";
import { queryClient, trpcClient } from "@/lib/trpc";
import type { FileEvent } from "@nimbus/api/file-events";

export default function Home() {
  const { data, isPending } = useSession();
  const email = data?.user?.email ?? "Signed in";
  const [latestEvent, setLatestEvent] = useState<FileEvent | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);
  const listQuery = useQuery({
    queryKey: ["files.list"],
    queryFn: () => trpcClient.files.list.query(),
    enabled: Boolean(data),
  });

  useEffect(() => {
    if (!data) {
      return;
    }

    const subscription = trpcClient.files.onChange.subscribe(undefined, {
      onData: (event) => {
        setLatestEvent(event);
        setEventError(null);
        queryClient.invalidateQueries({ queryKey: ["files.list"] });
      },
      onError: (error) => {
        setEventError(error.message);
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [data]);

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

        {data ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <div className="space-y-3">
              <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                Files (root)
              </p>
              {listQuery.isLoading ? (
                <p className="text-pretty text-sm text-zinc-600 dark:text-zinc-400">
                  Loading files...
                </p>
              ) : listQuery.isError ? (
                <p className="text-pretty text-sm text-red-600 dark:text-red-400">
                  {listQuery.error instanceof Error
                    ? listQuery.error.message
                    : "Failed to load files."}
                </p>
              ) : listQuery.data && listQuery.data.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {listQuery.data.slice(0, 20).map((entry) => (
                    <li
                      key={entry.path}
                      className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-zinc-700 dark:border-zinc-800 dark:text-zinc-200"
                    >
                      <span className="truncate">{entry.name}</span>
                      <span className="text-xs uppercase text-zinc-400 dark:text-zinc-500">
                        {entry.type}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-pretty text-sm text-zinc-600 dark:text-zinc-400">
                  No files found in the data root.
                </p>
              )}
            </div>
          </section>
        ) : null}

        <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="space-y-2">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
              Live file events
            </p>
            {eventError ? (
              <p className="text-pretty text-sm text-red-600 dark:text-red-400">
                {eventError}
              </p>
            ) : latestEvent ? (
              <div className="space-y-1 text-pretty text-sm">
                <p>
                  <span className="font-medium">Event:</span>{" "}
                  {latestEvent.event}
                </p>
                <p>
                  <span className="font-medium">Path:</span> {latestEvent.path}
                </p>
                <p>
                  <span className="font-medium">Time:</span>{" "}
                  {new Date(latestEvent.ts).toLocaleTimeString()}
                </p>
              </div>
            ) : (
              <p className="text-pretty text-sm text-zinc-600 dark:text-zinc-400">
                Waiting for file changes in /data.
              </p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
