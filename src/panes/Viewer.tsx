import {
  memo,
  useCallback,
  useEffect,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  blameAge,
  blameAuthor,
  blameRows,
  blameShown,
  blameTitle,
  blameVersion,
  isUncommitted,
  setBlameShown,
  subscribeBlame,
} from "../lib/blame";
import { copyText } from "../lib/editing";
import { highlightCode, highlightDiff, languageForPath } from "../lib/highlight";
import { diffFileHeaderPath, diffHeaderPath, diffLineClass } from "../lib/diff";
import { clearEditorFacts, factsFor, publishEditorFacts } from "../lib/editorFacts";
import {
  formatText,
  gitBlame,
  gitShow,
  readTextFileMeta,
  revealPath,
  writeTextFile,
} from "../lib/ipc";
import { CHORD } from "../lib/keybindings";
import { useMenu, type MenuEntry } from "../lib/menu";
import { baseName, parentDir } from "../lib/paths";
import type { Blame, BlameCommit } from "../lib/types";

/**
 * Ceiling on rendered diff lines. One DOM node per line with no virtualisation,
 * so an unbounded patch — a commit touching a generated file — otherwise locks
 * the renderer up for seconds.
 */
const MAX_DIFF_LINES = 5000;

/**
 * Start of the marker `git.rs` appends when a patch hit its byte budget. No git
 * output line can begin with it, so a prefix test is unambiguous. Keep in sync
 * with `patch_cut_marker()` there.
 */
const PATCH_CUT_MARKER = "… patch cut off at";

/** One file's worth of a multi-file patch, as its own collapsible block. */
interface PatchFile {
  /** `diff --git` line index, which is unique within a patch. */
  key: number;
  label: string;
  /** Post-image path (pre-image for a delete), which names the grammar. */
  path: string | null;
  lines: string[];
  added: number;
  removed: number;
}

/**
 * Number of files a patch can hold before sections open collapsed.
 *
 * A commit touching thirty files is a list to scan, not a wall to scroll; one
 * touching three is something you came to read.
 */
const AUTO_EXPAND_FILES = 6;

/**
 * Size past which the editor stops colouring and shows plain text.
 *
 * Higher than the chat's ceiling: a file this pane opens is being read, and
 * every keystroke re-tokenises the whole buffer, so the number is set by what
 * stays responsive to type in rather than by what is worth reading.
 */
const EDITOR_HIGHLIGHT_MAX = 200_000;

/** Path a `diff --git a/x b/y` header is about, preferring the post-image. */
function fileLabelOf(header: string): string {
  const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!match) return header.replace(/^diff --git /, "");
  const [, before, after] = match;
  if (after === "dev/null") return `${before} (deleted)`;
  if (before === "dev/null") return `${after} (new)`;
  return before === after ? after : `${before} → ${after}`;
}

/**
 * Split a patch into per-file sections.
 *
 * Anything before the first `diff --git` — `git show`'s message and diffstat —
 * becomes the preamble, so it keeps its place above the files rather than being
 * folded into the first one.
 */
function splitPatch(lines: string[]): { preamble: string[]; files: PatchFile[] } {
  const preamble: string[] = [];
  const files: PatchFile[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      files.push({
        key: index,
        label: fileLabelOf(line),
        path: diffHeaderPath(line),
        lines: [line],
        added: 0,
        removed: 0,
      });
      continue;
    }
    const current = files[files.length - 1];
    if (current === undefined) {
      preamble.push(line);
      continue;
    }
    current.lines.push(line);
    // `+++`/`---` are the file headers, not changed lines; counting them would
    // add a phantom +1/-1 to every file in the patch.
    if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
  }
  return { preamble, files };
}

/**
 * Colourised diff lines, one DOM node each.
 *
 * Given a language, the text of every content line is syntax-highlighted too;
 * the stylesheet then tints the row by side and leaves the words their colours.
 */
const DiffLines = memo(function DiffLines({
  lines,
  language = null,
}: {
  lines: string[];
  language?: string | null;
}) {
  const rendered = useMemo(() => highlightDiff(lines, language), [lines, language]);
  return (
    <>
      {rendered.map((nodes, index) => (
        <div key={index} className={diffLineClass(lines[index])}>
          {/* An empty div has no height, and a blank diff line still needs its row. */}
          {lines[index] === "" ? " " : nodes}
        </div>
      ))}
    </>
  );
});

/** Grammar for a file named in a patch, or null when the name says nothing. */
const languageForPatchPath = (path: string | null): string | null =>
  path === null ? null : languageForPath(path);

export const DiffView = memo(function DiffView({ patch }: { patch: string }) {
  const menu = useMenu();
  /** Right-click anywhere in a patch: take the whole thing, or the selection. */
  const patchMenu = useCallback(
    (): MenuEntry[] => [
      { label: "Copy Whole Patch", run: () => void copyText(patch) },
      "separator",
      "editing",
    ],
    [patch],
  );
  // Split and cap once per patch, not once per parent render — patches reach
  // thousands of lines, each with its own class computation.
  const { preamble, files, flat, flatLanguage, hidden, cutNote } = useMemo(() => {
    const lines = patch.split("\n");
    // The last element is the artefact of the trailing newline, so the marker,
    // when present, is the one before it.
    const lastIndex = lines[lines.length - 1] === "" ? lines.length - 2 : lines.length - 1;
    let cutNote: string | null = null;
    if (lastIndex >= 0 && lines[lastIndex].startsWith(PATCH_CUT_MARKER)) {
      cutNote = lines[lastIndex];
      lines.length = lastIndex; // reported in the footer, not colourised as a diff line
    }
    const shown = lines.slice(0, MAX_DIFF_LINES);
    const hidden = lines.length - shown.length;
    const { preamble, files } = splitPatch(shown);
    // Not a patch at all — an error string, or `(no textual diff)`. Nothing to
    // section, so render it as it came.
    // A patch without git's own headers (`diff -u`) still names its file on the
    // `+++` line, which is enough to pick a grammar for the whole thing.
    const header = shown.find((line) => line.startsWith("+++ ") || line.startsWith("--- "));
    const flatLanguage =
      header === undefined ? null : languageForPatchPath(diffFileHeaderPath(header));
    return files.length === 0
      ? { preamble: [], files: [], flat: shown, flatLanguage, hidden, cutNote }
      : { preamble, files, flat: null, flatLanguage: null, hidden, cutNote };
  }, [patch]);

  /**
   * Files the user has toggled away from the default. Keyed by section, so
   * collapsing one file does not disturb the rest, and reset per patch — the
   * keys are line offsets and mean nothing in the next one.
   */
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  useEffect(() => setToggled({}), [patch]);
  const defaultOpen = files.length <= AUTO_EXPAND_FILES;

  const footer =
    hidden > 0 || cutNote !== null ? (
      <div className="diff-meta">
        {hidden > 0
          ? `… truncated, ${hidden.toLocaleString()} more line${hidden === 1 ? "" : "s"}` +
            // The backend already dropped an unknown amount, so `hidden` is not
            // the whole remainder; say so instead of printing a second number.
            (cutNote !== null ? " of an already capped patch" : "")
          : cutNote}
      </div>
    ) : null;

  if (flat !== null) {
    return (
      <pre
        className="diff-view selectable"
        onContextMenu={(event) => menu.openContextMenu(event, patchMenu())}
      >
        <DiffLines lines={flat} language={flatLanguage} />
        {footer}
      </pre>
    );
  }

  return (
    <div
      className="diff-view-sections"
      onContextMenu={(event) => menu.openContextMenu(event, patchMenu())}
    >
      {preamble.length > 0 && (
        <pre className="diff-view selectable diff-preamble">
          <DiffLines lines={preamble} />
        </pre>
      )}
      {files.length > 1 && (
        <div className="diff-file-actions">
          <button
            className="toggle-button"
            onClick={() =>
              setToggled(Object.fromEntries(files.map((file) => [file.key, !defaultOpen])))
            }
          >
            {defaultOpen ? "Collapse all" : "Expand all"}
          </button>
          <span className="count">
            {files.length} file{files.length === 1 ? "" : "s"}
          </span>
        </div>
      )}
      {files.map((file) => {
        const open = toggled[file.key] ?? defaultOpen;
        return (
          <div className="diff-file" key={file.key}>
            <div
              className="diff-file-head"
              onClick={() => setToggled((current) => ({ ...current, [file.key]: !open }))}
              title={file.label}
            >
              <span className="twisty">{open ? "▾" : "▸"}</span>
              <span className="diff-file-name">{file.label}</span>
              {file.added > 0 && <span className="diff-add">+{file.added}</span>}
              {file.removed > 0 && <span className="diff-del">−{file.removed}</span>}
            </div>
            {open && (
              <pre className="diff-view selectable">
                <DiffLines lines={file.lines} language={languageForPatchPath(file.path)} />
              </pre>
            )}
          </div>
        );
      })}
      {footer}
    </div>
  );
});

/* ---------- diffs synthesised from a tool call ---------- */

/**
 * Longest side an LCS diff is computed for.
 *
 * The table is `before × after` cells, so this bounds it at ~160k — nothing next
 * to a render, while an `Edit` rewriting a whole generated file stays cheap. Past
 * it the two sides are shown whole instead, which is what the raw input showed
 * anyway.
 */
const LCS_LINE_CAP = 400;

/** Prefixed lines, ready for `diffLineClass`. */
function lineDiff(before: string[], after: string[]): string[] {
  if (before.length > LCS_LINE_CAP || after.length > LCS_LINE_CAP) {
    return [...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)];
  }
  const rows = before.length;
  const columns = after.length;
  const stride = columns + 1;
  // Suffix LCS lengths: `table[i * stride + j]` is the LCS of `before[i..]` and
  // `after[j..]`, which lets the walk below run forwards and keep line order.
  const table = new Uint32Array((rows + 1) * stride);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i * stride + j] =
        before[i] === after[j]
          ? table[(i + 1) * stride + j + 1] + 1
          : Math.max(table[(i + 1) * stride + j], table[i * stride + j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      out.push(` ${before[i]}`);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * stride + j] >= table[i * stride + j + 1]) {
      out.push(`-${before[i]}`);
      i += 1;
    } else {
      out.push(`+${after[j]}`);
      j += 1;
    }
  }
  while (i < rows) out.push(`-${before[i++]}`);
  while (j < columns) out.push(`+${after[j++]}`);
  return out;
}

/** `""` splits to `[""]`, which would show as a spurious blank changed line. */
function splitSide(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Render an edit-shaped tool input as a diff, or `null` when the input is not
 * one.
 *
 * Returning null is what keeps the caller honest: a shape that does not match —
 * a future tool, or an `Edit` whose arguments are still streaming — falls back
 * to the raw key dump rather than to an empty diff.
 */
export function toolDiffLines(
  name: string,
  input: Record<string, unknown>,
): string[] | null {
  if (name === "Edit") {
    const before = asString(input.old_string);
    const after = asString(input.new_string);
    if (before === null || after === null) return null;
    const lines = lineDiff(splitSide(before), splitSide(after));
    return input.replace_all === true ? ["@@ every occurrence @@", ...lines] : lines;
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const lines: string[] = [];
    (input.edits as unknown[]).forEach((raw, index) => {
      if (typeof raw !== "object" || raw === null) return;
      const edit = raw as Record<string, unknown>;
      const before = asString(edit.old_string);
      const after = asString(edit.new_string);
      if (before === null || after === null) return;
      lines.push(
        `@@ edit ${index + 1} of ${(input.edits as unknown[]).length}${
          edit.replace_all === true ? ", every occurrence" : ""
        } @@`,
      );
      lines.push(...lineDiff(splitSide(before), splitSide(after)));
    });
    return lines.length > 0 ? lines : null;
  }
  // Write and NotebookEdit carry only the post-image: whatever was there before
  // is not in the frame, so every line is shown as added rather than guessed at.
  const whole =
    name === "Write"
      ? asString(input.content)
      : name === "NotebookEdit"
        ? asString(input.new_source)
        : null;
  if (whole === null) return null;
  return splitSide(whole).map((line) => `+${line}`);
}

/** Diff synthesised from a tool call, for the chat's IN pane. */
export const ToolDiff = memo(function ToolDiff({
  lines,
  language = null,
}: {
  lines: string[];
  /** Grammar of the file being edited, for syntax colour inside the diff. */
  language?: string | null;
}) {
  const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
  return (
    <pre className="diff-view selectable tool-diff">
      <DiffLines lines={shown} language={language} />
      {shown.length < lines.length && (
        <div className="diff-meta">
          … truncated, {(lines.length - shown.length).toLocaleString()} more lines
        </div>
      )}
    </pre>
  );
});

/* ---------- file editor ---------- */

/**
 * Marker `write_text_file` puts in its error when the file changed underneath.
 * Keep in sync with `workspace.rs`.
 */
const STALE_MARKER = "STALE:";

interface FileViewProps {
  path: string;
  /**
   * Whether this pane is the one on screen.
   *
   * File tabs stay mounted while hidden — an unmount would throw away an unsaved
   * draft on a tab switch — so the window-level shortcut has to be gated, or
   * every open editor would save on one Ctrl+S.
   */
  visible?: boolean;
  /** Reports unsaved changes upward, so the tab can show a dirty mark. */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /**
   * Registers a save function while this pane is mounted, so a close-confirm
   * elsewhere can flush the buffer instead of only offering to discard it. It
   * resolves to whether the write landed — a refused save must not be read as
   * permission to close the tab.
   */
  onRegisterSave?: (path: string, save: (() => Promise<boolean>) | null) => void;
  /**
   * Same, for Format Document: the menu bar and the chord both act on the file
   * in front, and the buffer they have to reformat lives in here.
   */
  onRegisterFormat?: (path: string, format: (() => Promise<boolean>) | null) => void;
  /**
   * Where to put the caret, from a search result that was clicked.
   *
   * `nonce` is the trigger, not the position: two clicks on different matches in
   * the same file can carry the same line, and only something that always
   * changes makes the second one move anything.
   */
  reveal?: { line: number; column: number; nonce: number };
  /**
   * Opens a patch in a diff tab, for a commit picked out of the blame column.
   *
   * Optional: without it the column still names who wrote each line, it just
   * cannot show what else that commit touched.
   */
  onShowDiff?: (title: string, patch: string) => void;
}

/**
 * What the status line has to say, which is the tail of whatever was last done
 * to the buffer. One state rather than one per action: only the most recent of
 * "saved", "formatted" and "refused" is ever worth showing.
 */
type EditorState =
  | { kind: "clean" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "formatting" }
  | { kind: "formatted"; formatter: string; changed: boolean }
  | { kind: "error"; message: string }
  | { kind: "stale" };

/**
 * File viewer and editor.
 *
 * Editing is deliberately plain — a textarea, a gutter, and one save — because
 * the interesting problem here is not the editor but the second writer: claude
 * is editing the same tree, so the mtime the bytes were read at rides along with
 * every save and a save that would clobber someone else's work is refused.
 */
export const FileView = memo(function FileView({
  path,
  visible = true,
  onDirtyChange,
  onRegisterSave,
  onRegisterFormat,
  reveal,
  onShowDiff,
}: FileViewProps) {
  const menu = useMenu();
  /** What is on disk, as far as this pane knows. */
  const [saved, setSaved] = useState<{ text: string; modifiedMs: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<EditorState>({ kind: "clean" });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const blameRef = useRef<HTMLDivElement | null>(null);

  /** Who last touched each line, and why the column may have nothing to say. */
  const [blame, setBlame] = useState<Blame | null>(null);
  const [blameError, setBlameError] = useState<string | null>(null);
  // The switch is shared by every mounted editor — see `lib/blame.ts`. The
  // version is the snapshot and the value is read alongside it, as in
  // `editorFacts`.
  useSyncExternalStore(subscribeBlame, blameVersion, blameVersion);
  const blameOn = blameShown();

  const dirty = saved !== null && draft !== saved.text;

  const load = useCallback(
    async (signal?: { cancelled: boolean }) => {
      try {
        const file = await readTextFileMeta(path);
        if (signal?.cancelled) return;
        setSaved({ text: file.content, modifiedMs: file.modifiedMs });
        setDraft(file.content);
        setError(null);
        setState({ kind: "clean" });
      } catch (e) {
        if (signal?.cancelled) return;
        setError(String(e));
      }
    },
    [path],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    setSaved(null);
    setDraft("");
    setError(null);
    setState({ kind: "clean" });
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  /**
   * Save, resolving once the write has landed.
   *
   * `force` drops the mtime check, which is only reachable from the button the
   * stale banner offers — the point of the check is that nothing else can skip
   * it silently.
   */
  const save = useCallback(
    async (force = false): Promise<boolean> => {
      if (saved === null) return false;
      const text = draft;
      setState({ kind: "saving" });
      try {
        const modifiedMs = await writeTextFile(
          path,
          text,
          force ? undefined : saved.modifiedMs,
        );
        setSaved({ text, modifiedMs });
        setState({ kind: "saved" });
        return true;
      } catch (e) {
        const message = String(e);
        setState(message.includes(STALE_MARKER) ? { kind: "stale" } : { kind: "error", message });
        return false;
      }
    },
    [draft, path, saved],
  );

  /**
   * Reformat the buffer with whatever formatter the repo uses.
   *
   * Applied through the textarea rather than through `setDraft`, for the reason
   * the Tab handler below reaches for `execCommand` too: assigning `value` throws
   * away the native undo stack, and a format that cannot be taken back with
   * Ctrl+Z is one nobody runs on a file they care about.
   *
   * Nothing here writes: the backend formats text into text, so the draft stays
   * a draft and the mtime a save has to carry is still the one the file was read
   * at. Whether the result is saved is the same decision it was before.
   */
  const format = useCallback(async (): Promise<boolean> => {
    const field = textareaRef.current;
    // The field's own value, not `draft`: a keystroke in the same tick as this
    // call has reached the DOM but not yet the state.
    const before = field?.value ?? draft;
    setState({ kind: "formatting" });
    let result;
    try {
      result = await formatText(path, before);
    } catch (e) {
      // No formatter installed for this file type arrives here too. It is a note
      // rather than a failure, and reads as one in the status line.
      setState({ kind: "error", message: String(e) });
      return false;
    }
    if (result.changed) {
      if (field) {
        // The caret keeps its offset, which after a reflow is near where it was
        // rather than exactly on it — enough to not lose your place in a long
        // file, and the scroll position does the rest.
        const caret = field.selectionStart ?? 0;
        const { scrollTop, scrollLeft } = field;
        field.focus();
        field.setSelectionRange(0, field.value.length);
        if (!document.execCommand("insertText", false, result.text)) {
          field.value = result.text;
          setDraft(result.text);
        }
        const clamped = Math.min(caret, field.value.length);
        field.setSelectionRange(clamped, clamped);
        field.scrollTop = scrollTop;
        field.scrollLeft = scrollLeft;
      } else {
        setDraft(result.text);
      }
    }
    setState({ kind: "formatted", formatter: result.formatter, changed: result.changed });
    return true;
  }, [draft, path]);

  /** Latest save and format, for listeners and for the parent's registration. */
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  const formatRef = useRef(format);
  useEffect(() => {
    formatRef.current = format;
  }, [format]);

  useEffect(() => {
    onDirtyChange?.(path, dirty);
  }, [dirty, onDirtyChange, path]);

  // Unmounting means the tab is gone or another one is in front; either way the
  // dirty mark and the save hook must not outlive the buffer they describe.
  useEffect(
    () => () => {
      onDirtyChange?.(path, false);
      onRegisterSave?.(path, null);
      onRegisterFormat?.(path, null);
    },
    [onDirtyChange, onRegisterFormat, onRegisterSave, path],
  );

  useEffect(() => {
    onRegisterSave?.(path, () => saveRef.current(false));
    onRegisterFormat?.(path, () => formatRef.current());
  }, [onRegisterFormat, onRegisterSave, path]);

  // Ctrl+S from anywhere in the window, not only from inside the textarea, so
  // the shortcut works with the cursor parked on the gutter or the toolbar.
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "s" || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      event.preventDefault();
      void saveRef.current(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible]);

  /** Read inside the focus handler below, which must see the live buffer. */
  const savedRef = useRef(saved);
  const draftRef = useRef(draft);
  useEffect(() => {
    savedRef.current = saved;
    draftRef.current = draft;
  }, [draft, saved]);

  /** The `nonce` already acted on, so a save cannot re-trigger an old jump. */
  const revealedRef = useRef(0);

  /**
   * Land the caret on the line a search result named.
   *
   * Waits on `saved`: a freshly opened tab mounts with an empty buffer and the
   * read is a round trip, so the jump has to happen when the text arrives rather
   * than when the click did. The line is selected, not just scrolled to — coming
   * from a list of matches, seeing *which* text matched is the point — and the
   * gutter and highlight layers are nudged directly because they are scrolled
   * from the textarea's own handler, which a programmatic scroll may or may not
   * reach first.
   */
  useEffect(() => {
    if (!reveal || saved === null) return;
    if (revealedRef.current === reveal.nonce) return;
    const field = textareaRef.current;
    if (!field) return;
    revealedRef.current = reveal.nonce;

    // The draft, not what is on disk: this is where the caret is going, and a
    // dirty buffer is what the reader is looking at.
    const lines = draftRef.current.split("\n");
    const index = Math.min(Math.max(reveal.line, 1), lines.length) - 1;
    let lineStart = 0;
    for (let before = 0; before < index; before += 1) lineStart += lines[before].length + 1;
    const column = Math.min(Math.max(reveal.column, 1) - 1, lines[index].length);

    field.focus();
    field.setSelectionRange(lineStart + column, lineStart + lines[index].length);

    const style = getComputedStyle(field);
    // `line-height: 1.5` on a 12px font computes to a px value; `normal` would
    // not, and a NaN scrollTop silently leaves the view where it was.
    const lineHeight = Number.parseFloat(style.lineHeight) || 18;
    const padding = Number.parseFloat(style.paddingTop) || 0;
    // A third down rather than at the top: a match reads with the lines above it.
    const top = Math.max(0, padding + index * lineHeight - field.clientHeight / 3);
    field.scrollTop = top;
    if (gutterRef.current) gutterRef.current.scrollTop = top;
    if (highlightRef.current) highlightRef.current.scrollTop = top;
    if (blameRef.current) blameRef.current.scrollTop = top;
  }, [reveal, saved]);

  // Reload when the window regains focus and nothing local would be lost:
  // claude edits these files, and a stale buffer that only says so at save time
  // is worse than one that quietly caught up.
  useEffect(() => {
    if (!visible || dirty) return;
    const onFocus = () => {
      void readTextFileMeta(path)
        .then((file) => {
          const current = savedRef.current;
          if (current === null || current.modifiedMs === file.modifiedMs) return;
          // Re-checked here, not only in the effect's guard: the read is a round
          // trip, and a keystroke landing inside it must not have its edit
          // replaced by what was on disk before it.
          if (draftRef.current !== current.text) return;
          setSaved({ text: file.content, modifiedMs: file.modifiedMs });
          setDraft(file.content);
          setState({ kind: "clean" });
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [dirty, path, visible]);

  /**
   * Typing invalidates the note the status line is showing.
   *
   * Only the format note: "Saved" is already gated on the buffer being clean,
   * and an error is what you came back to read.
   */
  const onDraftChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    setState((current) => (current.kind === "formatted" ? { kind: "clean" } : current));
  }, []);

  /** Tab indents instead of leaving the field. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const field = event.currentTarget;
    // `insertText` keeps the native undo stack, which `value = ...` throws away —
    // Ctrl+Z after an indent is the whole point.
    if (!document.execCommand("insertText", false, "  ")) {
      const { selectionStart, selectionEnd, value } = field;
      field.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
      field.selectionStart = field.selectionEnd = selectionStart + 2;
      setDraft(field.value);
    }
  }, []);

  /**
   * Right-click in the editor.
   *
   * The editing block comes from the sentinel rather than being rebuilt here, so
   * cut/copy/paste behave the same in this textarea as in every other field.
   */
  const editorMenu = useCallback(
    (): MenuEntry[] => [
      {
        label: "Save",
        accelerator: CHORD.save,
        disabled: !dirty || state.kind === "saving",
        run: () => void save(false),
      },
      {
        label: "Format Document",
        accelerator: CHORD.format,
        disabled: state.kind === "saving" || state.kind === "formatting",
        run: () => void format(),
      },
      {
        label: dirty ? "Revert to Disk" : "Reload from Disk",
        danger: dirty,
        disabled: state.kind === "saving",
        run: () => void load(),
      },
      "separator",
      {
        label: "Show Blame",
        checked: blameOn,
        run: () => setBlameShown(!blameOn),
      },
      "separator",
      "editing",
      "separator",
      { label: "Copy Path", run: () => void copyText(path) },
      { label: "Copy File Name", run: () => void copyText(baseName(path)) },
      { label: "Reveal in File Manager", run: () => void revealPath(path) },
      {
        label: "Reveal Containing Folder",
        disabled: parentDir(path) === "",
        run: () => void revealPath(parentDir(path)),
      },
    ],
    [dirty, state.kind, save, format, load, path, blameOn],
  );

  const language = useMemo(() => languageForPath(path), [path]);

  /*
   * Read blame while the column is showing, and re-read it after every write.
   *
   * Keyed on the saved file's mtime, which is what a save and a reload both
   * move: `git blame` describes the file on disk, so the answer is only stale
   * once those bytes change. A draft nobody has saved does not invalidate it —
   * it just shifts which line each answer belongs to, which is what the column
   * says by dimming rather than by re-reading something git cannot see.
   */
  const savedAt = saved?.modifiedMs ?? null;
  useEffect(() => {
    if (!blameOn || savedAt === null) {
      setBlame(null);
      setBlameError(null);
      return;
    }
    let cancelled = false;
    void gitBlame(path)
      .then((next) => {
        if (cancelled) return;
        setBlame(next);
        setBlameError(null);
      })
      .catch((e) => {
        // Not a repo, an untracked file, no git at all. git's own words, in the
        // bar rather than over the file: none of them stops you editing it.
        if (cancelled) return;
        setBlame(null);
        setBlameError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [blameOn, path, savedAt]);

  /** Open what else a blamed commit touched, in a diff tab. */
  const openBlameCommit = useCallback(
    (commit: BlameCommit) => {
      if (!onShowDiff || isUncommitted(commit.sha)) return;
      void gitShow(parentDir(path), commit.sha)
        .then((patch) => onShowDiff(`${commit.shortSha} ${commit.summary}`, patch))
        .catch((e) => setBlameError(String(e)));
    },
    [onShowDiff, path],
  );

  /*
   * The menu api, behind a ref.
   *
   * Its identity changes whenever any menu opens or closes, and the rows below
   * are memoised on their handlers — depending on it directly would rebuild one
   * node per line of the file every time a context menu anywhere is dismissed.
   */
  const menuRef = useRef(menu);
  useEffect(() => {
    menuRef.current = menu;
  }, [menu]);

  const blameMenu = useCallback(
    (commit: BlameCommit): MenuEntry[] => {
      const uncommitted = isUncommitted(commit.sha);
      return [
        { header: uncommitted ? "Not committed yet" : `${commit.shortSha} ${commit.summary}` },
        !uncommitted && {
          label: "View Commit Changes",
          disabled: !onShowDiff,
          run: () => openBlameCommit(commit),
        },
        !uncommitted && "separator",
        !uncommitted && { label: "Copy Commit Hash", run: () => void copyText(commit.sha) },
        !uncommitted && { label: "Copy Short Hash", run: () => void copyText(commit.shortSha) },
        !uncommitted && { label: "Copy Summary", run: () => void copyText(commit.summary) },
        !uncommitted && {
          label: "Copy Author",
          run: () => void copyText(`${commit.author} <${commit.authorEmail}>`),
        },
        "separator",
        { label: "Hide Blame", run: () => setBlameShown(false) },
      ];
    },
    [onShowDiff, openBlameCommit],
  );

  /*
   * The column's rows, built once per blame rather than once per keystroke.
   *
   * Memoised for the same reason the highlighter is: this is one node per line
   * of the file, and typing must not rebuild them. The elements come back
   * identical between renders, so React skips the subtree entirely.
   */
  const blameNodes = useMemo(() => {
    if (blame === null) return null;
    return blameRows(blame).map((row, index) => (
      <div
        key={index}
        className="blame-line"
        data-uncommitted={isUncommitted(row.commit.sha)}
        title={blameTitle(row.commit)}
        onClick={() => openBlameCommit(row.commit)}
        onContextMenu={(event) => menuRef.current.openContextMenu(event, blameMenu(row.commit))}
      >
        {/* Only the first line of a run is labelled: the blank rows under it are
            what make a commit's lines read as one block. */}
        {row.first && (
          <>
            <span className="blame-author">{blameAuthor(row.commit)}</span>
            <span className="blame-age">{blameAge(row.commit.timestamp)}</span>
          </>
        )}
      </div>
    ));
  }, [blame, blameMenu, openBlameCommit]);

  /**
   * Publish the caret row for the status bar.
   *
   * Read off the field rather than out of `draft`: this is called from the same
   * handlers that set `draft`, and the state behind it is one render old.
   */
  const reportFacts = useCallback(() => {
    const field = textareaRef.current;
    if (!field) return;
    publishEditorFacts(factsFor(path, field.value, field.selectionStart ?? 0));
  }, [path]);

  /*
   * Only the pane on screen describes itself, and it stops when it leaves.
   *
   * Editors stay mounted when hidden — an unmount would throw away an unsaved
   * draft — so without the gate every open file would be publishing over the
   * others. The clear is keyed on the path for the same reason: two editors
   * changing places both fire, in whichever order React runs them.
   */
  useEffect(() => {
    if (!visible) return;
    reportFacts();
    return () => clearEditorFacts(path);
  }, [visible, path, reportFacts]);
  // Typing must not wait on the tokeniser: the deferred copy lags behind during
  // a burst of keystrokes and catches up once it stops, so the caret never does.
  const deferredDraft = useDeferredValue(draft);
  const tokens = useMemo(
    () => highlightCode(deferredDraft, language, EDITOR_HIGHLIGHT_MAX),
    [deferredDraft, language],
  );

  const lineCount = useMemo(() => draft.split("\n").length, [draft]);
  const gutter = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );

  if (error !== null) return <div className="empty-note">{error}</div>;
  if (saved === null) return <div className="empty-note">Loading…</div>;

  let status: ReactNode = null;
  if (state.kind === "saving") status = <span className="count">Saving…</span>;
  else if (state.kind === "saved" && !dirty) status = <span className="count">Saved</span>;
  else if (state.kind === "error") status = <span className="diff-del">{state.message}</span>;
  else if (state.kind === "formatting") status = <span className="count">Formatting…</span>;
  else if (state.kind === "formatted")
    status = (
      <span className="count">
        {state.changed
          ? `Formatted with ${state.formatter}`
          : `Already formatted (${state.formatter})`}
      </span>
    );
  else if (dirty) status = <span className="count">Unsaved</span>;

  return (
    <div className="editor" onContextMenu={(event) => menu.openContextMenu(event, editorMenu())}>
      <div className="editor-bar">
        <span className="editor-path" title={path}>
          {dirty && <span className="editor-dirty">●</span>}
          {path}
        </span>
        {status}
        {/* git's own refusal, kept short in the bar and whole in the hover: an
            untracked file has no history, and that is not an editing error. */}
        {blameOn && blameError !== null && (
          <span className="editor-blame-note" title={blameError}>
            {blameError}
          </span>
        )}
        <div className="actions">
          <button
            className="toggle-button"
            data-active={blameOn}
            onClick={() => setBlameShown(!blameOn)}
            title="Who last touched each line, from git blame"
          >
            Blame
          </button>
          <button
            className="toggle-button"
            onClick={() => void format()}
            disabled={state.kind === "saving" || state.kind === "formatting"}
            title={`Reformat with the repo's own formatter (${CHORD.format})`}
          >
            Format
          </button>
          <button
            className="toggle-button"
            onClick={() => void save(false)}
            disabled={!dirty || state.kind === "saving"}
            title="Ctrl+S"
          >
            Save
          </button>
          <button
            className="toggle-button"
            onClick={() => void load()}
            disabled={state.kind === "saving"}
            title={dirty ? "Discard changes and re-read from disk" : "Re-read from disk"}
          >
            {dirty ? "Revert" : "Reload"}
          </button>
        </div>
      </div>
      {state.kind === "stale" && (
        <div className="editor-conflict">
          <span>Changed on disk since it was opened — probably by claude.</span>
          <button className="toggle-button" onClick={() => void load()}>
            Discard mine, reload
          </button>
          <button className="toggle-button" onClick={() => void save(true)}>
            Overwrite anyway
          </button>
        </div>
      )}
      <div className="editor-body">
        {/* Left of the line numbers, as `git gui blame` puts it, and its own
            scroller driven from the textarea — the same arrangement the gutter
            uses, and for the same reason. Dimmed while the buffer is dirty:
            blame describes the file on disk, so an unsaved insertion above a
            line means these names are one or more rows out. */}
        {blameOn && blameNodes !== null && (
          <div
            className="editor-blame"
            ref={blameRef}
            data-stale={dirty}
            title={
              dirty
                ? "Blame is from the file on disk — unsaved edits shift which line each name belongs to"
                : undefined
            }
          >
            {blameNodes}
          </div>
        )}
        <div className="editor-gutter" ref={gutterRef} aria-hidden>
          {gutter}
        </div>
        <div className="editor-code">
          {/* The coloured copy of the buffer, painted under a textarea whose own
              text is transparent. The textarea stays the only thing focus,
              selection and the caret ever touch, so none of the editing
              behaviour is reimplemented here. */}
          <pre className="editor-highlight hljs" aria-hidden ref={highlightRef}>
            {tokens}
            {/* A <pre> swallows one trailing newline; the textarea shows it, and
                without this the last line drifts out of step with the gutter. */}
            {"\n"}
          </pre>
          <textarea
            ref={textareaRef}
            className="editor-input selectable"
            value={draft}
            spellCheck={false}
            wrap="off"
            onChange={(event) => {
              onDraftChange(event);
              reportFacts();
            }}
            onKeyDown={onKeyDown}
            // Caret moves that are not edits: a click, an arrow key, a selection.
            onSelect={reportFacts}
            // The gutter and the highlight layer are separate scrollers driven
            // from here; neither has a scrollbar of its own and neither can
            // drift out of step with the text it sits beside.
            onScroll={(event) => {
              const { scrollTop, scrollLeft } = event.currentTarget;
              const gutterElement = gutterRef.current;
              if (gutterElement) gutterElement.scrollTop = scrollTop;
              const blameElement = blameRef.current;
              if (blameElement) blameElement.scrollTop = scrollTop;
              const highlightElement = highlightRef.current;
              if (highlightElement) {
                highlightElement.scrollTop = scrollTop;
                highlightElement.scrollLeft = scrollLeft;
              }
            }}
          />
        </div>
      </div>
    </div>
  );
});
