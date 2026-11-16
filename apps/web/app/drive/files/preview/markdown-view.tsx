import Markdown, { type ReactRenderer } from "marked-react";
import type { ReactNode } from "react";
import { languageForFence } from "./code-highlight";
import CodeView from "./code-view";

/** Only absolute web, mail and in-page links; never javascript:, data: or relative. */
export const safeHref = (href: string) =>
  /^(?:https?:\/\/|mailto:|#)/i.test(href) && !/[\x00-\x20\x7f]/.test(href)
    ? href
    : undefined;

// Rendered to React elements, never innerHTML. Raw HTML is dropped and images
// show their alt text, so a file cannot run script or contact other servers.
const renderer: Partial<ReactRenderer> = {
  html: () => null,
  image(this: ReactRenderer, _src: string, alt: string) {
    return (
      <span key={this.elementId} className="text-muted-foreground">
        [{alt || "image"}]
      </span>
    );
  },
  link(this: ReactRenderer, href: string, text: ReactNode) {
    const target = safeHref(href);
    return target ? (
      <a
        key={this.elementId}
        href={target}
        target={target.startsWith("#") ? undefined : "_blank"}
        rel="noopener noreferrer nofollow"
      >
        {text}
      </a>
    ) : (
      <span key={this.elementId}>{text}</span>
    );
  },
  code(this: ReactRenderer, code: ReactNode, lang: string | undefined) {
    const language = languageForFence(lang);
    const text = typeof code === "string" ? code : String(code ?? "");
    return (
      <div key={this.elementId} className="overflow-x-auto rounded-md bg-muted">
        {language ? (
          <CodeView text={text} language={language} className="p-3" />
        ) : (
          <pre className="m-0 w-max min-w-full p-3 font-mono text-sm leading-5">
            {text}
          </pre>
        )}
      </div>
    );
  },
};

export default function MarkdownView({ text }: { text: string }) {
  return (
    <article className="max-w-none space-y-4 p-6 text-sm leading-6 text-pretty [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:font-mono [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:text-balance [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:font-semibold [&_hr]:border-border [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_p_code]:rounded-sm [&_p_code]:bg-muted [&_p_code]:px-1 [&_table]:w-max [&_table]:border-collapse [&_td]:border [&_td]:px-3 [&_td]:py-1.5 [&_th]:border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-6 [&_ul:has(input)]:list-none [&_ul:has(input)]:pl-1">
      <Markdown gfm breaks={false} renderer={renderer}>
        {text}
      </Markdown>
    </article>
  );
}
