"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { signOut, useSession } from "@/lib/auth-client";
import { trpcClient } from "@/lib/trpc";
import type { FileDelta } from "@nimbus/api/file-events";

type Params = {
  path?: string[] | string;
};

const normalizePathSegments = (pathParam: Params["path"]) => {
  if (!pathParam) {
    return [];
  }
  if (Array.isArray(pathParam)) {
    return pathParam;
  }
  return [pathParam];
};

export default function FilesPage() {
  const params = useParams<Params>();
  const pathSegments = useMemo(
    () => normalizePathSegments(params?.path),
    [params?.path],
  );
  const currentPath = pathSegments.join("/");

  const { data, isPending } = useSession();
  const listQuery = useQuery({
    queryKey: ["files.list", currentPath],
    queryFn: () =>
      trpcClient.files.list.query(
        currentPath ? { path: currentPath } : {},
      ),
    enabled: Boolean(data),
  });

  const [entries, setEntries] = useState(listQuery.data ?? []);

  useEffect(() => {
    if (listQuery.data) {
      setEntries(listQuery.data);
    }
  }, [listQuery.data]);

  useEffect(() => {
    if (!data) {
      return;
    }

    const subscription = trpcClient.files.onChange.subscribe(
      currentPath ? { path: currentPath } : {},
      {
        onData: (delta: FileDelta) => {
          setEntries((prev) => {
            const next = [...prev];
            const index = next.findIndex((entry) => entry.path === delta.path);

            if (delta.action === "removed") {
              if (index >= 0) {
                next.splice(index, 1);
              }
              return next;
            }

            const updated = {
              name: delta.name,
              path: delta.path,
              type: delta.type,
            };

            if (index >= 0) {
              next[index] = updated;
              return next;
            }

            next.push(updated);
            return next;
          });
        },
      },
    );

    return () => {
      subscription.unsubscribe();
    };
  }, [data, currentPath]);

  return (
    <div className="min-h-dvh bg-zinc-50 px-6 py-12 text-zinc-900 dark:bg-black dark:text-zinc-50">
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-500 dark:text-zinc-400">
            <Link className="underline-offset-4 hover:underline" href="/">
              Nimbus
            </Link>
            <span>/</span>
            <span>Files</span>
          </div>
          <h1 className="text-balance text-3xl font-semibold">Your files</h1>
          <p className="text-pretty text-base text-zinc-600 dark:text-zinc-400">
            Browse the data root and watch changes stream in live.
          </p>
        </header>

        <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          {isPending ? (
            <p className="text-pretty text-sm text-zinc-600 dark:text-zinc-400">
              Checking session...
            </p>
          ) : data ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                <Link className="underline-offset-4 hover:underline" href="/files">
                  root
                </Link>
                {pathSegments.map((segment, index) => {
                  const crumbPath = pathSegments.slice(0, index + 1).join("/");
                  return (
                    <span key={crumbPath} className="flex items-center gap-2">
                      <span>/</span>
                      <Link
                        className="underline-offset-4 hover:underline"
                        href={`/files/${crumbPath}`}
                      >
                        {segment}
                      </Link>
                    </span>
                  );
                })}
              </div>

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
              ) : entries.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {entries.map((entry) => (
                    <li
                      key={entry.path}
                      className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-zinc-700 dark:border-zinc-800 dark:text-zinc-200"
                    >
                      {entry.type === "dir" ? (
                        <Link
                          className="truncate underline-offset-4 hover:underline"
                          href={`/files/${entry.path}`}
                        >
                          {entry.name}
                        </Link>
                      ) : (
                        <span className="truncate">{entry.name}</span>
                      )}
                      <span className="text-xs uppercase text-zinc-400 dark:text-zinc-500">
                        {entry.type}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-pretty text-sm text-zinc-600 dark:text-zinc-400">
                  No files found in this folder.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-pretty text-sm text-zinc-600 dark:text-zinc-400">
                Sign in to browse your files.
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
          <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            <span>Signed in as {data.user?.email ?? "user"}.</span>
            <button
              className="text-zinc-900 underline-offset-4 hover:underline dark:text-zinc-50"
              type="button"
              onClick={() => signOut()}
            >
              Sign out
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
