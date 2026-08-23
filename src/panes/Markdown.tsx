import { memo, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { clipboardSet } from "../lib/ipc";

interface MarkdownProps {
  children: string;
  /** Called when a fenced path or inline code that looks like a path is clicked. */
  onOpenFile?: (path: string) => void;
}

/** Inline code that looks like a path gets a click target. */
const PATH_LIKE = /^(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+(?::\d+)?$/;

function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(0);

  // The reset must not fire into an unmounted component.
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const copy = useCallback(async () => {
    try {
      await clipboardSet(code);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable; the code is still selectable by hand.
    }
  }, [code]);

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{language ?? "text"}</span>
        <button onClick={() => void copy()} title="Copy">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * Assistant text rendered as GitHub-flavoured markdown, matching what the
 * Claude Code VSCode extension does (it bundles react-markdown + remark-gfm).
 *
 * Raw HTML is deliberately NOT enabled: model output is untrusted input, and
 * `rehype-raw` would let it inject markup into the app's own DOM.
 */
export const Markdown = memo(function Markdown({ children, onOpenFile }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children: content, ...props }) {
            const text = String(content).replace(/\n$/, "");
            const fenced = /language-(\w+)/.exec(className ?? "");
            // react-markdown v10 gives fenced blocks a language class; anything
            // without one and without a newline is inline code.
            if (!fenced && !text.includes("\n")) {
              const isPath = PATH_LIKE.test(text);
              return (
                <code
                  {...props}
                  className={isPath && onOpenFile ? "inline-code path" : "inline-code"}
                  onClick={
                    isPath && onOpenFile
                      ? () => onOpenFile(text.replace(/:\d+$/, ""))
                      : undefined
                  }
                >
                  {text}
                </code>
              );
            }
            return <CodeBlock language={fenced?.[1] ?? null} code={text} />;
          },
          // Links would navigate the whole webview away from the app.
          a({ href, children: content }) {
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  if (href) void clipboardSet(href);
                }}
                title={`${href} — click to copy`}
              >
                {content}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
