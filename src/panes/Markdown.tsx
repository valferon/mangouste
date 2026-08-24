import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode } from "../lib/highlight";
import { clipboardSet, openExternal } from "../lib/ipc";
import { useMenu } from "../lib/menu";

interface MarkdownProps {
  children: string;
  /** Called when a fenced path or inline code that looks like a path is clicked. */
  onOpenFile?: (path: string) => void;
}

/** Inline code that looks like a path gets a click target. */
const PATH_LIKE = /^(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+(?::\d+)?$/;

function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const menu = useMenu();
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

  // Re-tokenising is the expensive part of rendering a streaming message, and
  // the deltas that do not touch this block must not pay for it.
  const tokens = useMemo(() => highlightCode(code, language), [code, language]);

  return (
    <div
      className="code-block"
      onContextMenu={(event) =>
        menu.openContextMenu(event, [
          { label: "Copy Code Block", run: () => void copy() },
          "separator",
          "editing",
        ])
      }
    >
      <div className="code-head">
        <span className="code-lang">{language ?? "text"}</span>
        <button onClick={() => void copy()} title="Copy">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code className="hljs">{tokens}</code>
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
  const menu = useMenu();
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
                  onContextMenu={(event) =>
                    menu.openContextMenu(event, [
                      isPath &&
                        Boolean(onOpenFile) && {
                          label: "Open File",
                          run: () => onOpenFile?.(text.replace(/:\d+$/, "")),
                        },
                      { label: "Copy", run: () => void clipboardSet(text) },
                      "separator",
                      "editing",
                    ])
                  }
                >
                  {text}
                </code>
              );
            }
            return <CodeBlock language={fenced?.[1] ?? null} code={text} />;
          },
          // Following a link in place would navigate the whole webview away
          // from the app, so it goes to the desktop browser instead. Modifier
          // clicks copy, which is all a link could do before.
          a({ href, children: content }) {
            return (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  if (!href) return;
                  if (event.metaKey || event.ctrlKey || event.altKey) {
                    void clipboardSet(href);
                    return;
                  }
                  // A scheme the OS will not take (or a bare `#anchor`) is
                  // still worth copying rather than swallowing the click.
                  void openExternal(href).then((opened) => {
                    if (!opened) void clipboardSet(href);
                  });
                }}
                title={`${href} — click to open, ${
                  navigator.platform.includes("Mac") ? "⌘" : "Ctrl"
                }-click to copy`}
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
