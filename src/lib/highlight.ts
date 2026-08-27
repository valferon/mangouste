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
import { diffSide } from "./diff";

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

/* ---------- line-oriented highlighting ---------- */

/**
 * Ceiling for a tool's IN/OUT pane.
 *
 * Lower than a fenced block's: at `verbose` every tool row in a transcript opens
 * at once, so hydrating a long session pays this cost a few hundred times over.
 * A 20k tokenise is ~15ms; the 99th-percentile Bash result is 13k.
 */
export const TOOL_HIGHLIGHT_MAX = 20_000;

/** A stretch of text on one line and the scope chain it sits in, outermost first. */
export interface Run {
  text: string;
  scopes: string[];
}

/**
 * Cut a highlighted tree into lines.
 *
 * highlight.js scopes span newlines freely — a docstring is one `hljs-string`
 * however long it is — while a numbered file or a diff needs one node list per
 * line. So the tree is walked once and every text node split at its newlines,
 * each piece remembering the scopes that were open around it. That is what keeps
 * the second line of a multi-line string coloured as a string, which a
 * line-at-a-time highlight can never know.
 */
export function runsByLine(nodes: RootContent[]): Run[][] {
  const lines: Run[][] = [[]];
  const visit = (children: RootContent[], scopes: string[]) => {
    for (const node of children) {
      if (node.type === "text") {
        node.value.split("\n").forEach((part, index) => {
          if (index > 0) lines.push([]);
          if (part !== "") lines[lines.length - 1].push({ text: part, scopes });
        });
      } else if (node.type === "element") {
        const className = (node as Element).properties?.className;
        const own = Array.isArray(className) ? className.map(String).join(" ") : "";
        visit((node as Element).children, own ? [...scopes, own] : scopes);
      }
    }
  };
  visit(nodes, []);
  return lines;
}

/** One run as nested spans, so descendant selectors like `.hljs-meta .hljs-string` still match. */
function runToReact(run: Run, key: number): ReactNode {
  if (run.scopes.length === 0) return run.text;
  let node: ReactNode = run.text;
  for (let index = run.scopes.length - 1; index > 0; index -= 1) {
    node = createElement("span", { className: run.scopes[index] }, node);
  }
  return createElement("span", { key, className: run.scopes[0] }, node);
}

const plainLines = (code: string): ReactNode[][] => code.split("\n").map((line) => [line]);

/**
 * `highlightCode`, one node list per line. Always exactly `code.split("\n")`
 * many, highlighted or not, so a caller can zip it against its own line list.
 */
export function highlightLines(
  code: string,
  language: string | null,
  maxChars = TOOL_HIGHLIGHT_MAX,
): ReactNode[][] {
  if (!language || code.length > maxChars) return plainLines(code);
  const name = language.toLowerCase();
  if (!lowlight.registered(name)) return plainLines(code);
  try {
    const lines = runsByLine(lowlight.highlight(name, code).children).map((runs) =>
      runs.map(runToReact),
    );
    // A grammar that lost or invented a newline would misalign every line after
    // it against the caller's numbering; plain text is the honest fallback.
    return lines.length === code.split("\n").length ? lines : plainLines(code);
  } catch {
    return plainLines(code);
  }
}

/**
 * Syntax-highlight the content of unified-diff lines.
 *
 * Each side is reassembled and tokenised whole — the pre-image from context and
 * removed lines, the post-image from context and added — then dealt back out in
 * diff order. Highlighting the diff text line by line instead would colour the
 * inside of a multi-line string as code, which is exactly where an edit most
 * needs to be read carefully.
 *
 * Every returned line keeps its `+`/`-`/` ` marker as a leading string; the
 * highlighted remainder is wrapped in a `.hljs` span so the stylesheet can hand
 * the text back to the syntax colours while the marker keeps the side's colour.
 * Header lines, and everything when `language` is null, come back as one plain
 * string, unchanged.
 */
export function highlightDiff(
  lines: string[],
  language: string | null,
  maxChars = TOOL_HIGHLIGHT_MAX,
): ReactNode[][] {
  const plain = lines.map((line) => [line] as ReactNode[]);
  if (!language) return plain;
  const sides = lines.map(diffSide);
  const before: string[] = [];
  const after: string[] = [];
  lines.forEach((line, index) => {
    const side = sides[index];
    if (side === "old" || side === "both") before.push(line.slice(1));
    if (side === "new" || side === "both") after.push(line.slice(1));
  });
  const beforeText = before.join("\n");
  const afterText = after.join("\n");
  if (beforeText.length > maxChars || afterText.length > maxChars) return plain;
  // `"".split("\n")` is one empty line, so an absent side must not be highlighted
  // at all or its phantom line would be dealt out to the first change.
  const oldLines = before.length === 0 ? [] : highlightLines(beforeText, language, maxChars);
  const newLines = after.length === 0 ? [] : highlightLines(afterText, language, maxChars);
  let oldAt = 0;
  let newAt = 0;
  return lines.map((line, index) => {
    const side = sides[index];
    if (side === "none") return [line];
    let content: ReactNode[];
    if (side === "old") content = oldLines[oldAt++];
    else if (side === "new") content = newLines[newAt++];
    else {
      oldAt += 1;
      content = newLines[newAt++];
    }
    return [line[0], createElement("span", { key: "c", className: "hljs" }, ...content)];
  });
}
