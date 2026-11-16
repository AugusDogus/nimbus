import { FileKind, type CodeLanguage } from "@/lib/file-kind";
import {
  TOKEN_STYLES,
  type HighlightRequest,
  type HighlightResponse,
} from "./highlight-protocol";

export type Tokens = Extract<HighlightResponse, { type: "tokens" }>;

/** Colors paint through CSS Custom Highlights: no element per token. */
export const highlightSupported = () =>
  typeof CSS !== "undefined" && "highlights" in CSS;

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (response: HighlightResponse) => void>();

/** Tokenize off the main thread. Resolves null when highlighting failed. */
export function tokenizeCode(text: string, language: CodeLanguage) {
  if (!worker) {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener(
      "message",
      (event: MessageEvent<HighlightResponse>) => {
        waiting.get(event.data.id)?.(event.data);
        waiting.delete(event.data.id);
      },
    );
  }
  const id = nextId++;
  const request: HighlightRequest = { id, text, language };
  const active = worker;
  return new Promise<Tokens | null>((resolve) => {
    waiting.set(id, (response) =>
      resolve(response.type === "tokens" ? response : null),
    );
    active.postMessage(request);
  });
}

/** Every mounted view's ranges, merged into one Highlight per token type. */
const owners = new Map<symbol, Map<number, Range[]>>();

function publish() {
  for (const [type, style] of Object.entries(TOKEN_STYLES)) {
    const ranges: Range[] = [];
    for (const groups of owners.values())
      for (const range of groups.get(Number(type)) ?? []) ranges.push(range);
    if (ranges.length) CSS.highlights.set(style.name, new Highlight(...ranges));
    else CSS.highlights.delete(style.name);
  }
}

/** Paint tokens whose start lies in [from, to) of a single text node. */
export function paintTokens(
  owner: symbol,
  node: Text,
  tokens: Tokens,
  from: number,
  to: number,
) {
  const groups = new Map<number, Range[]>();
  let low = 0;
  let high = tokens.ends.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens.ends[middle] <= from) low = middle + 1;
    else high = middle;
  }
  for (let i = low; i < tokens.starts.length && tokens.starts[i] < to; i++) {
    const range = new Range();
    range.setStart(node, tokens.starts[i]);
    range.setEnd(node, Math.min(tokens.ends[i], node.length));
    const list = groups.get(tokens.types[i]);
    if (list) list.push(range);
    else groups.set(tokens.types[i], [range]);
  }
  owners.set(owner, groups);
  publish();
}

export function clearTokens(owner: symbol) {
  if (owners.delete(owner)) publish();
}

export const highlightStyles = Object.values(TOKEN_STYLES)
  .map(({ name, color }) => `::highlight(${name}){color:${color}}`)
  .join("");

const fenceNames: Record<string, CodeLanguage> = {
  bash: "shell",
  c: "c",
  "c#": "csharp",
  "c++": "cpp",
  console: "shell",
  cpp: "cpp",
  csharp: "csharp",
  css: "css",
  go: "go",
  golang: "go",
  html: "html",
  java: "java",
  javascript: "javascript",
  json: "json",
  kotlin: "kotlin",
  lua: "lua",
  php: "php",
  python: "python",
  ruby: "ruby",
  rust: "rust",
  shell: "shell",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  typescript: "typescript",
  xml: "xml",
  yaml: "yaml",
};

/** Language for a Markdown fence such as ```ts, or undefined when unknown. */
export function languageForFence(fence: string | undefined) {
  const name = fence?.trim().toLowerCase().split(/\s/)[0];
  if (!name) return undefined;
  const kind = FileKind.of(`fence.${name}`);
  return fenceNames[name] ?? (kind.type === "code" ? kind.language : undefined);
}
