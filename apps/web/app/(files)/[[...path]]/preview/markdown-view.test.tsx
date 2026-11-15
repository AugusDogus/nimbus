import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { languageForFence } from "./code-highlight";
import MarkdownView, { safeHref } from "./markdown-view";

const render = (text: string) => renderToStaticMarkup(<MarkdownView text={text} />);

describe("markdown preview", () => {
  it("renders GitHub-flavored markdown", () => {
    const html = render("# Title\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~ https://example.com\n\n```ts\nconst a = 1;\n```");
    expect(html).toContain("<h1");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("const a = 1;");
  });

  it("never emits script, event handlers, remote resources or unsafe links", () => {
    const html = render([
      "<script>alert(1)</script>",
      '<img src="https://tracker.example/x.png" onerror="alert(1)">',
      "![pixel](https://tracker.example/pixel.png)",
      "[click](javascript:alert(1))",
      "[entity](&#106;avascript:alert(1))",
      "[data](data:text/html;base64,PHNjcmlwdD4=)",
      "[relative](../secret.txt)",
      '<svg onload="alert(1)"></svg>',
      '<iframe src="https://example.com"></iframe>',
      '<style>body{background:url(https://tracker.example/)}</style>',
    ].join("\n\n"));
    expect(html).not.toMatch(/<(script|img|svg|iframe|style|object|embed)\b/i);
    expect(html).not.toMatch(/\son\w+=/i);
    expect(html).not.toMatch(/href="(?!https?:|mailto:|#)/i);
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("[pixel]");
  });

  it("allows only web, mail and in-page links", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeHref("#section")).toBe("#section");
    for (const href of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "//evil.example", "/api/files/download?path=a", "https://ex ample.com", "https://example.com/\u0000"])
      expect(safeHref(href)).toBeUndefined();
  });

  it("maps fence names to highlight languages", () => {
    expect(languageForFence("ts")).toBe("typescript");
    expect(languageForFence("Python")).toBe("python");
    expect(languageForFence("bash title=x")).toBe("shell");
    expect(languageForFence("tsx")).toBe("typescript");
    expect(languageForFence("brainfuck")).toBeUndefined();
    expect(languageForFence(undefined)).toBeUndefined();
  });
});
