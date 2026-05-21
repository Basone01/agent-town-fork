"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown renderer for task results.
 *
 * react-markdown parses to an AST and emits React elements — it never produces
 * a raw HTML string and does not render embedded HTML unless `rehype-raw` is
 * added. So untrusted markdown cannot inject script, satisfying the
 * CLAUDE.md rule against raw-HTML injection. `remark-gfm` adds GitHub-flavored
 * markdown: tables, task lists, strikethrough, autolinks.
 */
const COMPONENTS: Components = {
  // Links open in a new tab, safely. Only the props we need are forwarded —
  // `node` is intentionally not picked up so it never lands on the DOM element.
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="task-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
