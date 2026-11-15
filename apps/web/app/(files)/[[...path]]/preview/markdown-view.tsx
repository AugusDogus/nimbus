"use client";

export default function MarkdownView({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words p-4 font-mono text-sm">
      {text}
    </pre>
  );
}
