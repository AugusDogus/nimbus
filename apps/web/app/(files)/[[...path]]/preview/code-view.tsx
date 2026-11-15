"use client";

import type { CodeLanguage } from "@/lib/file-kind";

export default function CodeView({
  text,
}: {
  text: string;
  language: CodeLanguage;
}) {
  return (
    <pre className="whitespace-pre-wrap break-words p-4 font-mono text-sm">
      {text}
    </pre>
  );
}
