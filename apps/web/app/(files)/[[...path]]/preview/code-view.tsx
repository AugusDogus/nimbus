"use client";

import { useEffect, useMemo, useRef } from "react";
import type { CodeLanguage } from "@/lib/file-kind";
import { cn } from "@/lib/utils";
import {
  clearTokens,
  highlightStyles,
  highlightSupported,
  paintTokens,
  tokenizeCode,
} from "./code-highlight";

/** Lines painted beyond each edge of the viewport. */
const OVERSCAN = 120;

const prettyJson = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Invalid or partial JSON is shown exactly as stored.
    return text;
  }
};

/**
 * Highlighted, read-only source. The text is one DOM text node; colors are
 * CSS Custom Highlight ranges for the visible lines only, so a megabyte file
 * costs no more to scroll than a short one.
 */
export default function CodeView({
  text,
  language,
  className,
}: {
  text: string;
  language: CodeLanguage;
  className?: string;
}) {
  const display = useMemo(
    () =>
      language === "json" && !text.includes("\n") ? prettyJson(text) : text,
    [text, language],
  );
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const element = ref.current;
    const node = element?.firstChild;
    if (!element || !(node instanceof Text) || !highlightSupported()) return;
    const owner = Symbol("code-view");
    const lineStarts = [0];
    for (
      let i = display.indexOf("\n");
      i >= 0;
      i = display.indexOf("\n", i + 1)
    )
      lineStarts.push(i + 1);
    const scroller =
      element.closest<HTMLElement>("[data-preview-scroll]") ?? element;
    let cancelled = false;
    let painted: [number, number] | null = null;
    let frame = 0;
    let paint = () => {};

    void tokenizeCode(display, language).then((tokens) => {
      if (cancelled || !tokens) return;
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 20;
      paint = () => {
        frame = 0;
        // How far the top of the code sits above the scroller's visible top.
        const top =
          scroller.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        const first = Math.max(0, Math.floor(top / lineHeight));
        const last = Math.min(
          lineStarts.length - 1,
          Math.ceil((top + scroller.clientHeight) / lineHeight),
        );
        if (painted && first >= painted[0] && last <= painted[1]) return;
        const from = Math.max(0, first - OVERSCAN);
        const to = Math.min(lineStarts.length - 1, last + OVERSCAN);
        painted = [from, to];
        paintTokens(
          owner,
          node,
          tokens,
          lineStarts[from],
          to + 1 < lineStarts.length ? lineStarts[to + 1] : display.length,
        );
      };
      paint();
    });
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(() => paint());
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      clearTokens(owner);
    };
  }, [display, language]);

  return (
    <>
      <style href="nimbus-code-highlights" precedence="default">
        {highlightStyles}
      </style>
      <pre
        ref={ref}
        className={cn(
          "m-0 w-max min-w-full p-4 font-mono text-sm leading-5 whitespace-pre",
          className,
        )}
      >
        {display}
      </pre>
    </>
  );
}
