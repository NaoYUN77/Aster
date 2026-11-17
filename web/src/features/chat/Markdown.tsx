import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function childLanguage(node: ReactNode): string | undefined {
  if (node && typeof node === "object" && "props" in node) {
    const className = (node as { props: { className?: unknown } }).props.className;
    if (typeof className === "string") {
      const match = /language-([\w-]+)/.exec(className);
      return match?.[1];
    }
  }
  return undefined;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = extractText(children).replace(/\n$/, "");
  const language = childLanguage(children);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时保持静默，用户可以手动选择文本 */
    }
  };

  return (
    <div className="group/code my-3 overflow-hidden rounded-lg border border-border bg-code-bg">
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {language ?? "code"}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/code:opacity-100"
          aria-label="复制代码"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const safe =
    typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href)
      ? href
      : undefined;
  if (!safe) {
    return <span className="text-muted-foreground">{children}</span>;
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer noopener"
      className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
    >
      {children}
    </a>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ className, children }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return <code className={cn("font-mono", className)}>{children}</code>;
    }
    return (
      <code className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-[0.86em] text-foreground/90 ring-1 ring-border/60">
        {children}
      </code>
    );
  },
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  img: () => null,
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-xl font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-primary/40 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
  th: ({ children }) => (
    <th className="whitespace-nowrap border-b border-border px-3 py-2 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top last:border-b-0">{children}</td>
  ),
  tr: ({ children }) => <tr className="[&:last-child_td]:border-b-0">{children}</tr>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="text-[15px] text-foreground/95 [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
