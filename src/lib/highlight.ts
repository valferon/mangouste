/**
 * Syntax highlighting for fenced code blocks.
 *
 * lowlight wraps highlight.js but emits a hast tree instead of an HTML string,
 * which is why it is used here rather than highlight.js directly: model output
 * is untrusted input, and building React elements from the tree keeps
 * `dangerouslySetInnerHTML` out of the render path entirely — the same reason
 * `rehype-raw` is not enabled in `Markdown.tsx`.
 *
 * Colours are not baked in: every emitted span carries highlight.js' own
 * `hljs-*` class and the theme's `--syn-*` tokens in `styles.css` paint them,
 * so light and dark follow the rest of the app.
 */

import { createElement, type ReactNode } from "react";
import type { Element, RootContent } from "hast";
import { common, createLowlight } from "lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";

const lowlight = createLowlight(common);
// Not in highlight.js' common set, but common in a repo pane.
lowlight.register({ dockerfile });

/**
 * Ceiling on what gets tokenised.
 *
 * A streaming assistant block is re-rendered on every delta, so the cost of one
 * highlight is paid once per token of the whole message. Past this size the
 * pauses are visible, and a dump that big is being scrolled past, not read.
 */
const MAX_HIGHLIGHT_CHARS = 40_000;

/** hast subtree to React elements. Only the spans highlight.js emits appear. */
function toReact(nodes: RootContent[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const element = node as Element;
    const key = `${keyPrefix}.${index}`;
    const className = element.properties?.className;
    return createElement(
      "span",
      { key, className: Array.isArray(className) ? className.join(" ") : undefined },
      ...toReact(element.children, key),
    );
  });
}

/**
 * Tokenise `code` as `language`, falling back to the plain string whenever the
 * language is unknown, absent, or the block is too big to be worth it.
 *
 * Unlabelled fences are deliberately left plain rather than run through
 * `highlightAuto`: detection on a three-line snippet guesses wrong often
 * enough that the colours mislead.
 */
export function highlightCode(
  code: string,
  language: string | null,
  maxChars = MAX_HIGHLIGHT_CHARS,
): ReactNode {
  if (!language || code.length > maxChars) return code;
  const name = language.toLowerCase();
  if (!lowlight.registered(name)) return code;
  try {
    return toReact(lowlight.highlight(name, code).children, "h");
  } catch {
    // A grammar that throws on partial input must not take the message down.
    return code;
  }
}

/**
 * Extensions highlight.js does not resolve as language names or aliases itself.
 * Anything it already knows (`ts`, `py`, `rs`, `yml`, `toml`, …) is left out —
 * `registered()` below catches those.
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  cfg: "ini",
  conf: "ini",
  env: "ini",
  htm: "html",
  m: "objectivec",
  properties: "ini",
  tf: "ini",
};

/** Files named for what they are rather than for their extension. */
const FILENAME_LANGUAGE: Record<string, string> = {
  ".env": "ini",
  "cargo.lock": "toml",
  containerfile: "dockerfile",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  gnumakefile: "makefile",
  makefile: "makefile",
  rakefile: "ruby",
};

/**
 * Best guess at the language of a file on disk, or null to leave it plain.
 *
 * Guessing from the name only: sniffing content would disagree with the tab's
 * own label, and a wrong guess on a file being edited is worse than no colour.
 */
export function languageForPath(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const byName = FILENAME_LANGUAGE[name];
  if (byName) return byName;
  // `.gitignore` has no extension in the sense meant here, hence lastIndexOf > 0.
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1);
  return EXTENSION_LANGUAGE[extension] ?? (lowlight.registered(extension) ? extension : null);
}
