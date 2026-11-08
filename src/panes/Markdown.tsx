import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { previewFor } from "../lib/binary";
import { highlightCode } from "../lib/highlight";
import { clipboardSet, openExternal, readFileBytes } from "../lib/ipc";
import { resolvePath } from "../lib/paths";
import { isMac } from "../lib/platform";
import { useMenu } from "../lib/menu";

interface MarkdownProps {
  children: string;
  /** Called when a fenced path or inline code that looks like a path is clicked. */
  onOpenFile?: (path: string) => void;
  /**
   * The folder a markdown file lives in, when this is a preview of one.
   *
   * Relative links then open as files beside it, and relative images are read
   * from disk, as GitHub renders a README. Unset for Claude's prose, whose
   * links are the web's.
   */
  baseDir?: string;
}

/** A link or image source with a scheme of its own, or a bare `#anchor`. */
const NOT_A_FILE = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

/** `%20` back to a space; a malformed escape is left as written rather than thrown. */
function decodePath(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

/** Largest image a preview reads off disk, so a stray video link cannot stall it. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * An image beside the markdown file, read through the backend.
 *
 * The webview cannot load `file://`, and a relative `src` resolves against the
 * app's own origin, so the bytes come over IPC and go in as a data URL.
 */
function LocalImage({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    const preview = previewFor(path);
    if (preview.kind !== "image") {
      setFailed(true);
      return;
    }
    void readFileBytes(path, MAX_IMAGE_BYTES)
      .then((file) => {
        if (cancelled) return;
        if (file.truncated) setFailed(true);
        else setSrc(`data:${preview.mime};base64,${file.data}`);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (failed) return <span className="markdown-missing-image" title={path}>[{alt || path}]</span>;
  return src ? <img src={src} alt={alt} title={path} /> : null;
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
export const Markdown = memo(function Markdown({ children, onOpenFile, baseDir }: MarkdownProps) {
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
            // In a preview, `docs/setup.md` is the file beside this one.
            if (baseDir !== undefined && onOpenFile && href && !NOT_A_FILE.test(href)) {
              const target = resolvePath(baseDir, decodePath(href.replace(/[?#].*$/, "")));
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenFile(target);
                  }}
                  title={target}
                >
                  {content}
                </a>
              );
            }
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
                  isMac() ? "⌘" : "Ctrl"
                }-click to copy`}
              >
                {content}
              </a>
            );
          },
          img({ src, alt }) {
            if (baseDir !== undefined && typeof src === "string" && src && !NOT_A_FILE.test(src)) {
              return <LocalImage path={resolvePath(baseDir, decodePath(src))} alt={alt ?? ""} />;
            }
            return <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
