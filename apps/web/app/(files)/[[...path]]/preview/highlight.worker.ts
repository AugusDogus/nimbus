import { tokenize, type ParseOptions } from "sugar-high/core";
import type { CodeLanguage } from "@/lib/file-kind";
import type { HighlightRequest, HighlightResponse } from "./highlight-protocol";

type Tokenizer = (code: string) => Array<[number, string]>;

/** Grammars configured through parse options. */
const configured =
  (load: () => Promise<ParseOptions>) => async (): Promise<Tokenizer> => {
    const options = await load();
    return (code) => tokenize(code, options);
  };

/** Grammars that bring their own tokenizer (JavaScript family, HTML). */
const custom =
  (
    load: () => Promise<{
      tokenize: (code: string, options: undefined) => Array<[number, string]>;
    }>,
  ) =>
  async (): Promise<Tokenizer> => {
    const grammar = await load();
    return (code) => grammar.tokenize(code, undefined);
  };

// Each grammar is its own small chunk, fetched only for files that need it.
const grammars: Record<CodeLanguage, () => Promise<Tokenizer>> = {
  c: configured(() => import("sugar-high/lang/c")),
  cpp: configured(() => import("sugar-high/lang/cpp")),
  csharp: configured(() => import("sugar-high/lang/csharp")),
  css: configured(() => import("sugar-high/lang/css")),
  go: configured(() => import("sugar-high/lang/go")),
  html: custom(() => import("sugar-high/lang/html")),
  java: configured(() => import("sugar-high/lang/java")),
  javascript: custom(() => import("sugar-high/lang/javascript")),
  json: configured(() => import("sugar-high/lang/json")),
  kotlin: configured(() => import("sugar-high/lang/kotlin")),
  lua: configured(() => import("sugar-high/lang/lua")),
  php: configured(() => import("sugar-high/lang/php")),
  python: configured(() => import("sugar-high/lang/python")),
  ruby: configured(() => import("sugar-high/lang/ruby")),
  rust: configured(() => import("sugar-high/lang/rust")),
  shell: configured(() => import("sugar-high/lang/shell")),
  sql: configured(() => import("sugar-high/lang/sql")),
  swift: configured(() => import("sugar-high/lang/swift")),
  toml: configured(() => import("sugar-high/lang/toml")),
  typescript: custom(() => import("sugar-high/lang/typescript")),
  xml: custom(() => import("sugar-high/lang/html")),
  yaml: configured(() => import("sugar-high/lang/yaml")),
};

// Sugar High token type ids that carry a color; others stay plain text.
const COLORED = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

async function highlight({ id, text, language }: HighlightRequest) {
  let response: HighlightResponse;
  try {
    const tokens = (await grammars[language]())(text);
    const starts: number[] = [];
    const ends: number[] = [];
    const types: number[] = [];
    let offset = 0;
    for (const [type, value] of tokens) {
      if (COLORED.has(type) && value.trim()) {
        starts.push(offset);
        ends.push(offset + value.length);
        types.push(type);
      }
      offset += value.length;
    }
    response = {
      type: "tokens",
      id,
      starts: Uint32Array.from(starts),
      ends: Uint32Array.from(ends),
      types: Uint8Array.from(types),
    };
    postMessage(response, {
      transfer: [
        response.starts.buffer,
        response.ends.buffer,
        response.types.buffer,
      ],
    });
  } catch (error) {
    response = {
      type: "failed",
      id,
      message: error instanceof Error ? error.message : String(error),
    };
    postMessage(response);
  }
}

addEventListener(
  "message",
  (event: MessageEvent<HighlightRequest>) => void highlight(event.data),
);
