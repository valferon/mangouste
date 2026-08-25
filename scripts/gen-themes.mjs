/**
 * Generate `src/themes.css` from VS Code's own bundled colour themes.
 *
 * The palettes are not transcribed by hand: they are read out of the theme JSON
 * that ships inside a VS Code install, so "Monokai" here is the Monokai people
 * already know rather than an approximation of it. Run this again to add a theme
 * or to pick up upstream retunes:
 *
 *   npm run gen:themes -- [path-to-vscode-resources/app/extensions]
 *
 * A theme JSON gives far less than it looks like it does. VS Code fills most of
 * the workbench in code, so a sparse theme such as Dark+ names 36 colours and
 * inherits a few hundred. Everything this app needs and a theme does not name is
 * therefore derived from what it does name — see `pick` and the mixes below —
 * rather than left to a fallback that would make half the themes look identical.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOTS = [
  process.argv[2],
  "/usr/share/code/resources/app/extensions",
  "/usr/share/code-insiders/resources/app/extensions",
  "/snap/code/current/usr/share/code/resources/app/extensions",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions",
].filter(Boolean);

const root = ROOTS.find((path) => existsSync(join(path, "theme-defaults")));
if (!root) {
  console.error(
    `No VS Code install found. Looked in:\n  ${ROOTS.join("\n  ")}\n` +
      `Pass the extensions directory as an argument.`,
  );
  process.exit(1);
}

/** id, label, kind, and where the palette comes from. Order is menu order. */
const THEMES = [
  ["dark-plus", "Dark+", "dark", "theme-defaults/themes/dark_plus.json"],
  ["dark-modern", "Dark Modern", "dark", "theme-defaults/themes/dark_modern.json"],
  ["monokai", "Monokai", "dark", "theme-monokai/themes/monokai-color-theme.json"],
  ["monokai-dimmed", "Monokai Dimmed", "dark", "theme-monokai-dimmed/themes/dimmed-monokai-color-theme.json"],
  ["solarized-dark", "Solarized Dark", "dark", "theme-solarized-dark/themes/solarized-dark-color-theme.json"],
  ["abyss", "Abyss", "dark", "theme-abyss/themes/abyss-color-theme.json"],
  ["kimbie-dark", "Kimbie Dark", "dark", "theme-kimbie-dark/themes/kimbie-dark-color-theme.json"],
  ["red", "Red", "dark", "theme-red/themes/Red-color-theme.json"],
  ["tomorrow-night-blue", "Tomorrow Night Blue", "dark", "theme-tomorrow-night-blue/themes/tomorrow-night-blue-color-theme.json"],
  ["hc-black", "High Contrast Dark", "dark", "theme-defaults/themes/hc_black.json"],
  ["light-plus", "Light+", "light", "theme-defaults/themes/light_plus.json"],
  ["light-modern", "Light Modern", "light", "theme-defaults/themes/light_modern.json"],
  ["solarized-light", "Solarized Light", "light", "theme-solarized-light/themes/solarized-light-color-theme.json"],
  ["quiet-light", "Quiet Light", "light", "theme-quietlight/themes/quietlight-color-theme.json"],
  ["hc-light", "High Contrast Light", "light", "theme-defaults/themes/hc_light.json"],
];

/* ---------- colour arithmetic ---------- */

function parse(hex) {
  const raw = hex.replace("#", "");
  const full =
    raw.length <= 4
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

const hex = ({ r, g, b }) =>
  "#" + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("");

/** Flatten any alpha onto `over`, so every token this emits is opaque. */
function flatten(color, over) {
  const c = parse(color);
  if (c.a === 1) return hex(c);
  const b = parse(over);
  return hex({
    r: c.r * c.a + b.r * (1 - c.a),
    g: c.g * c.a + b.g * (1 - c.a),
    b: c.b * c.a + b.b * (1 - c.a),
  });
}

function mix(from, to, t) {
  const a = parse(from);
  const b = parse(to);
  return hex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
}

function luminance(color) {
  const { r, g, b } = parse(color);
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Push a colour away from the surface until it is readable on it.
 *
 * Only ever applied to values this script derived rather than read: a colour the
 * theme names is the theme's own decision and is left exactly as written.
 */
function readable(color, bg, kind, target) {
  if (contrast(color, bg) >= target) return color;
  const anchor = kind === "light" ? "#000000" : "#ffffff";
  for (let t = 0.05; t <= 0.8; t += 0.05) {
    const candidate = mix(color, anchor, t);
    if (contrast(candidate, bg) >= target) return candidate;
  }
  return mix(color, anchor, 0.8);
}

const alpha = (color, a) => color + Math.round(a * 255).toString(16).padStart(2, "0");

/* ---------- theme loading ---------- */

function load(path) {
  const theme = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  let colors = {};
  let tokens = [];
  if (theme.include) {
    const base = load(resolve(dirname(path), theme.include));
    colors = { ...base.colors };
    tokens = [...base.tokens];
  }
  return {
    colors: { ...colors, ...(theme.colors ?? {}) },
    tokens: [...tokens, ...(theme.tokenColors ?? [])],
  };
}

/**
 * Resolve a TextMate scope to a foreground.
 *
 * Rule scopes match by prefix — a rule for `string` colours
 * `string.quoted.double` — so the longest matching rule wins, and rules whose
 * scope is a descendant selector (`source.go entity.name`) are skipped because
 * they only apply inside a language this has no notion of.
 */
function scopeColor(tokens, query) {
  let best = null;
  let bestLength = -1;
  for (const rule of tokens) {
    const fg = rule.settings?.foreground;
    if (!fg) continue;
    const scopes = Array.isArray(rule.scope) ? rule.scope : String(rule.scope ?? "").split(",");
    for (const raw of scopes) {
      const scope = raw.trim();
      if (!scope || scope.includes(" ")) continue;
      if (query !== scope && !query.startsWith(scope + ".")) continue;
      if (scope.length > bestLength) {
        bestLength = scope.length;
        best = fg;
      }
    }
  }
  return best;
}

/** First scope in the list that the theme actually colours. */
function syntax(tokens, queries) {
  for (const query of queries) {
    const found = scopeColor(tokens, query);
    if (found) return found;
  }
  return null;
}

const SYNTAX_ROLES = {
  "--syn-comment": ["comment"],
  "--syn-keyword": ["storage.type", "storage", "keyword"],
  "--syn-control": ["keyword.control", "keyword"],
  "--syn-string": ["string.quoted", "string"],
  "--syn-number": ["constant.numeric", "constant"],
  "--syn-function": ["entity.name.function", "support.function"],
  "--syn-type": ["entity.name.type", "support.type", "support.class", "entity.name.class"],
  "--syn-variable": ["variable.other", "variable"],
  "--syn-constant": ["constant.language", "support.constant", "constant"],
  "--syn-tag": ["entity.name.tag", "meta.tag"],
  "--syn-regexp": ["string.regexp", "constant.character.escape"],
};

/** VS Code's own ANSI ramp, for the themes that do not name one. */
const ANSI = {
  dark: {
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
    brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
    brightCyan: "#29b8db", brightWhite: "#e5e5e5",
  },
  light: {
    black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800",
    blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
    brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14",
    brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc",
    brightCyan: "#0598bc", brightWhite: "#a5a5a5",
  },
};

function build(id, label, kind, file) {
  const { colors, tokens } = load(join(root, file));
  const pick = (...keys) => {
    for (const key of keys) {
      if (typeof key !== "string") return key;
      if (colors[key]) return colors[key];
    }
    return null;
  };

  const bg = flatten(pick("editor.background") ?? (kind === "dark" ? "#1e1e1e" : "#ffffff"), "#808080");
  const fg = flatten(pick("editor.foreground", "foreground") ?? (kind === "dark" ? "#cccccc" : "#3b3b3b"), bg);
  const toward = kind === "dark" ? "#ffffff" : "#000000";
  const away = kind === "dark" ? "#000000" : "#ffffff";

  const panel = flatten(pick("sideBar.background", "editorGroupHeader.tabsBackground") ?? mix(bg, away, 0.25), bg);
  const elevated = flatten(pick("editorWidget.background", "dropdown.background", "menu.background") ?? mix(bg, away, 0.3), bg);
  const hover = flatten(pick("list.hoverBackground") ?? mix(bg, toward, 0.08), bg);
  const active = flatten(pick("list.activeSelectionBackground", "editor.selectionBackground", "list.inactiveSelectionBackground") ?? mix(bg, toward, 0.2), bg);
  const border = flatten(pick("panel.border", "editorGroup.border", "sideBar.border", "contrastBorder") ?? mix(bg, toward, 0.16), bg);
  // Dim text has to be dimmer than plain text and still readable. Light Modern
  // sets `descriptionForeground` to exactly its `editor.foreground`, which is
  // faithful and useless here, so a candidate that is not actually quieter than
  // `fg` is passed over rather than accepted for having the right name.
  const plain = contrast(fg, bg);
  const dim = [
    pick("descriptionForeground"),
    pick("editorLineNumber.foreground"),
    mix(fg, bg, 0.35),
  ]
    .filter(Boolean)
    .map((color) => flatten(color, bg))
    .map((color) => readable(color, bg, kind, 4.0))
    .find((color) => contrast(color, bg) < plain * 0.92) ?? readable(mix(fg, bg, 0.35), bg, kind, 4.0);
  const accent = flatten(pick("button.background", "focusBorder", "textLink.foreground", "progressBar.background") ?? "#0078d4", bg);
  const accentFg = flatten(pick("button.foreground") ?? (luminance(accent) > 0.4 ? "#000000" : "#ffffff"), accent);

  const ansi = (name) => flatten(pick(`terminal.ansi${name[0].toUpperCase()}${name.slice(1)}`) ?? ANSI[kind][name], bg);
  const semantic = (name, target = 3.0) => readable(ansi(name), bg, kind, target);

  const red = semantic("red");
  const green = semantic("green");
  const amber = semantic("yellow");
  const blue = semantic("blue");
  const purple = semantic("magenta");
  const cyan = semantic("cyan");
  const orange = readable(mix(red, amber, 0.45), bg, kind, 3.0);

  const chip = (base) => ({
    bg: mix(base, bg, 0.72),
    fg: mix(base, toward, kind === "dark" ? 0.45 : 0.0) === base ? base : mix(base, toward, kind === "dark" ? 0.45 : 0.15),
  });
  const info = chip(blue);
  const head = chip(purple);

  const syn = {};
  for (const [token, queries] of Object.entries(SYNTAX_ROLES)) {
    const found = syntax(tokens, queries);
    syn[token] = found ? flatten(found, bg) : readable(mix(fg, bg, 0.2), bg, kind, 4.0);
  }

  return {
    id,
    label,
    kind,
    tokens: {
      "--bg": bg,
      "--bg-elevated": elevated,
      "--bg-panel": panel,
      "--bg-hover": hover,
      "--bg-active": active,
      "--border": border,
      "--fg": fg,
      "--fg-dim": dim,
      "--fg-bright": mix(fg, toward, 0.6),
      "--accent": accent,
      "--accent-fg": accentFg,
      "--green": green,
      "--amber": amber,
      "--red": red,
      "--purple": purple,
      "--orange": orange,
      "--blue": blue,
      "--cyan": cyan,
      "--chip-bg": info.bg,
      "--chip-fg": info.fg,
      "--chip-head-bg": head.bg,
      "--chip-head-fg": head.fg,
      "--status-idle": mix(dim, bg, 0.45),
      "--track": alpha(toward, 0.12),
      "--scrollbar-thumb": alpha(toward, 0.35),
      "--scrollbar-thumb-hover": alpha(toward, 0.55),
      "--scrim": alpha("#000000", kind === "dark" ? 0.4 : 0.25),
      "--shadow": alpha("#000000", kind === "dark" ? 0.65 : 0.2),
      // `black` must never equal the background, or ESC[30m text is invisible.
      "--term-black": contrast(ansi("black"), bg) < 1.4 ? mix(ansi("black"), toward, 0.3) : ansi("black"),
      "--term-white": ansi("white"),
      "--term-bright-black": ansi("brightBlack"),
      "--term-bright-red": ansi("brightRed"),
      "--term-bright-green": ansi("brightGreen"),
      "--term-bright-yellow": ansi("brightYellow"),
      "--term-bright-blue": ansi("brightBlue"),
      "--term-bright-magenta": ansi("brightMagenta"),
      "--term-bright-cyan": ansi("brightCyan"),
      "--term-bright-white": ansi("brightWhite"),
      ...syn,
    },
  };
}

const built = THEMES.map((args) => build(...args));

/**
 * Check the invariants here rather than in a test.
 *
 * The palettes live only in the generated CSS — deliberately, so the app does
 * not also ship 700 hex strings in its JS bundle — which means the place that
 * writes them is the only place that can check them. A theme missing a token
 * does not fall back to a sensible default: it inherits whatever the previously
 * applied theme left on :root, so a switch would leak one colour from the theme
 * before it, and only on that one pane, and only sometimes.
 */
const reference = Object.keys(built[0].tokens).sort();
if (reference.length < 40) {
  throw new Error(`only ${reference.length} tokens — the app needs more than that`);
}
for (const theme of built) {
  const keys = Object.keys(theme.tokens).sort();
  const missing = reference.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !reference.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`${theme.id}: missing ${missing.join(",")} extra ${extra.join(",")}`);
  }
  for (const [name, value] of Object.entries(theme.tokens)) {
    // xterm reads these out with getComputedStyle and hands them to a canvas,
    // which cannot resolve a var() or a color-mix().
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
      throw new Error(`${theme.id} ${name}: ${value} is not a hex colour`);
    }
  }
}

const byId = Object.fromEntries(built.map((theme) => [theme.id, theme]));

const block = (selector, theme) =>
  `${selector} {\n` +
  Object.entries(theme.tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n") +
  `\n}\n`;

const out =
  `/* Generated by scripts/gen-themes.mjs — do not edit by hand.\n` +
  `   Run \`npm run gen:themes\` to regenerate.\n\n` +
  `   Palettes are read out of the colour themes bundled with Visual Studio Code\n` +
  `   (MIT, Microsoft) and, for Solarized, Monokai, Kimbie and Tomorrow, the\n` +
  `   upstream palettes those themes package. Only the mapping onto this app's\n` +
  `   tokens is ours; the colours are theirs.\n\n` +
  `   Fonts and metrics are NOT here — they live in styles.css, which is what a\n` +
  `   theme switch must leave alone. */\n\n` +
  `/* Default, and what \`follow desktop\` paints when the desktop is dark. */\n` +
  block(":root", byId["dark-plus"]) +
  `\n/* \`follow desktop\`, light. Scoped to :not([data-theme]) so an explicit\n` +
  `   choice always wins over the desktop's preference. */\n` +
  `@media (prefers-color-scheme: light) {\n` +
  block("  :root:not([data-theme])", byId["light-plus"])
    .split("\n")
    .map((line) => (line.startsWith("  :root") || line === "}" ? line : line && "  " + line))
    .join("\n")
    .replace(/^}$/m, "  }") +
  `}\n\n` +
  built.map((theme) => `/* ${theme.label} */\n` + block(`:root[data-theme="${theme.id}"]`, theme)).join("\n");

writeFileSync("src/themes.css", out);

writeFileSync(
  "src/lib/themeList.ts",
  `/* Generated by scripts/gen-themes.mjs — do not edit by hand. */\n\n` +
    `export interface ThemeInfo {\n  id: string;\n  label: string;\n  kind: "dark" | "light";\n}\n\n` +
    `export const THEME_LIST: readonly ThemeInfo[] = [\n` +
    built.map((t) => `  { id: "${t.id}", label: "${t.label}", kind: "${t.kind}" },`).join("\n") +
    `\n];\n`,
);

console.log(`wrote src/themes.css and src/lib/themeList.ts (${built.length} themes)`);
for (const theme of built) {
  const t = theme.tokens;
  console.log(
    `${theme.id.padEnd(20)} bg=${t["--bg"]} fg=${t["--fg"]} ` +
      `fg/bg=${contrast(t["--fg"], t["--bg"]).toFixed(1)} ` +
      `dim/bg=${contrast(t["--fg-dim"], t["--bg"]).toFixed(1)} ` +
      `comment/bg=${contrast(t["--syn-comment"], t["--bg"]).toFixed(1)}`,
  );
}
