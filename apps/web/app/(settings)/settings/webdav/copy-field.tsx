"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          aria-label={label}
          readOnly
          value={value}
          onFocus={(event) => event.target.select()}
          className="min-w-0 bg-background font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          disabled={!value}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void (async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setError(null);
            } catch {
              setCopied(false);
              setError("Copy failed. Select the text and copy it manually.");
            }
          })()}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
      <span role="status" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
      {error && (
        <p role="alert" className="text-pretty text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
