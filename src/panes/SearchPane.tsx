import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../lib/editing";
import { replaceMatches, revealPath, searchText } from "../lib/ipc";
import { ClearIcon, FindReplaceIcon, RefreshIcon } from "../lib/icons";
import { useMenu, type MenuEntry } from "../lib/menu";
import { baseName, parentDir, relativePath } from "../lib/paths";
import type { FileHit, SearchMatch, SearchOptions, SearchOutcome } from "../lib/types";

interface SearchPaneProps {
  /** Repo the sweep runs over. Empty until a repo is open. */
  root: string;
  /**
   * Bumped by App whenever this view is deliberately revealed. Each new value
   * puts the caret in the query box, which is what the chord and the rail click
   * are both for — and what a stale value must not do at launch, where this can
   * be the restored view and the caret belongs to the session's composer.
   */
  focusToken: number;
  /** Open a file with the caret on the match that was clicked. */
  onOpenMatch: (path: string, line: number, column: number) => void;
}

/** Keystrokes settle before a repo-wide sweep starts. */
const DEBOUNCE_MS = 300;

/**
 * Shortest query that searches on its own.
 *
 * One character matches most of a repo, and the sweep is synchronous from the
 * pane's point of view — typing `e` on the way to `error` would block on tens of
 * thousands of matches nobody asked for. Enter still searches whatever is typed,
 * so the guard is a delay and never a refusal.
 */
const MIN_AUTO_QUERY = 2;

/** Per-sweep match ceiling asked of Rust, which clamps it again. */
const MATCH_BUDGET = 1_000;

/** Identity of one match inside the current result set. */
const matchKey = (path: string, hit: SearchMatch): string => `${path}:${hit.start}`;

/**
 * Find and replace across the active repo.
 *
 * The pane holds no search state Rust also holds: every sweep and every write
 * carries the query and the toggles with it, so what the results describe and
 * what a replace does cannot drift apart. Matches are addressed by the byte span
 * Rust found them at, which is what makes dismissing one meaningful — the write
 * gets the spans that survived, and Rust re-matches each one before touching it.
 *
 * Laid out like the VSCode Search view: query, replacement, the three matcher
 * toggles, the include/exclude boxes behind a disclosure, then results grouped
 * by file.
 */
export const SearchPane = memo(function SearchPane({
  root,
  focusToken,
  onOpenMatch,
}: SearchPaneProps) {
  const menu = useMenu();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** Matches excluded from the next replace, by `matchKey`. */
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const queryRef = useRef<HTMLInputElement | null>(null);

  const options = useMemo<SearchOptions>(
    () => ({
      caseSensitive,
      wholeWord,
      regex: useRegex,
      include,
      exclude,
      maxMatches: MATCH_BUDGET,
    }),
    [caseSensitive, wholeWord, useRegex, include, exclude],
  );

  /** Bumped per sweep, so a slow one for an older query is dropped. */
  const generation = useRef(0);
  /**
   * The query Enter forced past `MIN_AUTO_QUERY`.
   *
   * Without it, forcing a one-character sweep and then toggling Match Case would
   * wipe the results instead of re-running them — the toggle change re-enters
   * the effect below, which would refuse a query this short all over again.
   */
  const forced = useRef("");

  const run = useCallback(
    async (text: string) => {
      const sweep = (generation.current += 1);
      if (!root || text === "") {
        setOutcome(null);
        setError(null);
        setBusy(false);
        return;
      }
      setBusy(true);
      try {
        const found = await searchText(root, text, options);
        if (sweep !== generation.current) return;
        setOutcome(found);
        setError(null);
        // The old set addressed matches that no longer exist: spans move with
        // every edit, so keeping it would dismiss whatever now sits at those
        // offsets.
        setDismissed(new Set());
        setCollapsed(new Set());
      } catch (e) {
        if (sweep !== generation.current) return;
        // A half-typed regex is the common case here, and its message from the
        // regex crate is the useful one.
        setError(String(e));
        setOutcome(null);
      } finally {
        if (sweep === generation.current) setBusy(false);
      }
    },
    [root, options],
  );

  // Live search, once the typing stops. `note` is cleared here rather than in
  // the replace path: it describes a write, and the next search is what makes it
  // history.
  useEffect(() => {
    setNote(null);
    if (query === "") {
      generation.current += 1;
      forced.current = "";
      setOutcome(null);
      setError(null);
      setBusy(false);
      return;
    }
    if (query.length < MIN_AUTO_QUERY && forced.current !== query) return;
    const timer = setTimeout(() => void run(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, run]);

  // A result set belongs to the repo it was found in.
  useEffect(() => {
    setOutcome(null);
    setError(null);
    setNote(null);
  }, [root]);

  /** Starts at the mounted value, so a restored view does not grab the caret. */
  const focused = useRef(focusToken);

  // Revealing this view puts the caret in the box, with what is already there
  // selected so retyping replaces it rather than appending to it.
  useEffect(() => {
    if (focusToken === focused.current) return;
    focused.current = focusToken;
    const field = queryRef.current;
    if (!field) return;
    field.focus();
    field.select();
  }, [focusToken]);

  const files = outcome?.files ?? [];

  /** Matches still selected for replacement, per file. */
  const pending = useMemo(
    () =>
      files
        .map((file) => ({
          file,
          matches: file.matches.filter((hit) => !dismissed.has(matchKey(file.path, hit))),
        }))
        .filter((entry) => entry.matches.length > 0),
    [files, dismissed],
  );

  const pendingMatches = pending.reduce((sum, entry) => sum + entry.matches.length, 0);

  /**
   * Write the replacement into `entries`, then search again.
   *
   * The re-search is not cosmetic: after a write every span in the old results
   * is wrong, and a stale list whose rows still look clickable is a list that
   * would replace the wrong text next time.
   */
  const applyReplace = useCallback(
    async (entries: { file: FileHit; matches: SearchMatch[] }[]) => {
      if (entries.length === 0) return;
      setWriting(true);
      setError(null);
      try {
        const result = await replaceMatches(
          query,
          options,
          replacement,
          entries.map((entry) => ({
            path: entry.file.path,
            modifiedMs: entry.file.modifiedMs,
            spans: entry.matches.map((hit) => [hit.start, hit.end] as [number, number]),
          })),
        );
        const failures = result.files.filter((file) => file.error !== null);
        const touched = result.files.filter((file) => file.replaced > 0).length;
        setNote(
          `Replaced ${result.replaced} in ${touched} file${touched === 1 ? "" : "s"}` +
            (failures.length > 0
              ? ` · ${failures.length} refused: ${failures
                  .map((file) => `${baseName(file.path)} (${file.error})`)
                  .join(", ")}`
              : ""),
        );
      } catch (e) {
        setError(String(e));
      } finally {
        setWriting(false);
        await run(query);
      }
    },
    [query, options, replacement, run],
  );

  /**
   * Replace everything still selected.
   *
   * The one action here that asks first, and for the same reason `git discard`
   * does: it rewrites files across the tree in one click, and nothing in the app
   * can put them back. A single file's own button does not ask — that click
   * already names its target.
   */
  const replaceAll = useCallback(() => {
    if (pending.length === 0) return;
    const what = `${pendingMatches} match${pendingMatches === 1 ? "" : "es"} in ${
      pending.length
    } file${pending.length === 1 ? "" : "s"}`;
    if (pending.length > 1 && !window.confirm(`Replace ${what}? This writes to disk.`)) {
      return;
    }
    void applyReplace(pending);
  }, [pending, pendingMatches, applyReplace]);

  const replaceInFile = useCallback(
    (file: FileHit) => {
      const entry = pending.find((candidate) => candidate.file.path === file.path);
      if (entry) void applyReplace([entry]);
    },
    [pending, applyReplace],
  );

  const dismissMatch = useCallback((path: string, hit: SearchMatch) => {
    setDismissed((current) => new Set(current).add(matchKey(path, hit)));
  }, []);

  const dismissFile = useCallback((file: FileHit) => {
    setDismissed((current) => {
      const next = new Set(current);
      for (const hit of file.matches) next.add(matchKey(file.path, hit));
      return next;
    });
  }, []);

  const toggleFile = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /** What the pane itself can do, for every right-click in it. */
  const paneEntries = useCallback(
    (): MenuEntry[] => [
      { label: "Search Again", disabled: !query, run: () => void run(query) },
      { label: "Match Case", checked: caseSensitive, run: () => setCaseSensitive((v) => !v) },
      { label: "Whole Word", checked: wholeWord, run: () => setWholeWord((v) => !v) },
      { label: "Regular Expression", checked: useRegex, run: () => setUseRegex((v) => !v) },
      {
        label: "Files to Include or Exclude",
        checked: filtersOpen,
        run: () => setFiltersOpen((v) => !v),
      },
      "separator",
      {
        label: "Collapse All",
        disabled: files.length === 0,
        run: () => setCollapsed(new Set(files.map((file) => file.path))),
      },
      {
        label: "Expand All",
        disabled: collapsed.size === 0,
        run: () => setCollapsed(new Set()),
      },
      {
        label: "Clear Search",
        disabled: !query && !outcome,
        run: () => {
          setQuery("");
          setOutcome(null);
          setError(null);
          setNote(null);
        },
      },
    ],
    [query, run, caseSensitive, wholeWord, useRegex, filtersOpen, files, collapsed.size, outcome],
  );

  const fileMenu = useCallback(
    (file: FileHit): MenuEntry[] => [
      { header: file.relative },
      { label: "Open File", run: () => onOpenMatch(file.path, file.matches[0].line, 1) },
      {
        label: `Replace in this File (${
          pending.find((entry) => entry.file.path === file.path)?.matches.length ?? 0
        })`,
        disabled: writing || !pending.some((entry) => entry.file.path === file.path),
        run: () => replaceInFile(file),
      },
      { label: "Dismiss File", run: () => dismissFile(file) },
      "separator",
      { label: "Copy Path", run: () => void copyText(file.path) },
      { label: "Copy Relative Path", run: () => void copyText(relativePath(root, file.path)) },
      { label: "Reveal in File Manager", run: () => void revealPath(file.path) },
      "separator",
      ...paneEntries(),
    ],
    [onOpenMatch, pending, writing, replaceInFile, dismissFile, root, paneEntries],
  );

  const matchMenu = useCallback(
    (file: FileHit, hit: SearchMatch): MenuEntry[] => [
      { header: `${file.relative}:${hit.line}` },
      { label: "Open", run: () => onOpenMatch(file.path, hit.line, hit.column) },
      {
        label: "Dismiss Match",
        disabled: dismissed.has(matchKey(file.path, hit)),
        run: () => dismissMatch(file.path, hit),
      },
      "separator",
      {
        label: "Copy Line",
        run: () => void copyText(`${hit.before}${hit.matched}${hit.after}`),
      },
      { label: "Copy Match", run: () => void copyText(hit.matched) },
      "separator",
      ...paneEntries(),
    ],
    [onOpenMatch, dismissed, dismissMatch, paneEntries],
  );

  /**
   * Whether a row can show what the replacement will look like.
   *
   * Only for a literal replacement: in regex mode the text that lands depends on
   * the capture groups, and a preview computed here from a different engine than
   * the one that will do the write would eventually lie.
   */
  const previewable = replacement !== "" && !useRegex;

  const summary = (): React.ReactNode => {
    if (error) return <span className="search-error">{error}</span>;
    if (busy) return <span>searching…</span>;
    if (writing) return <span>writing…</span>;
    if (note) return <span title={note}>{note}</span>;
    if (!outcome) {
      return query.length > 0 && query.length < MIN_AUTO_QUERY ? (
        <span>press Enter to search a single character</span>
      ) : null;
    }
    if (outcome.totalMatches === 0) return <span>no results</span>;
    const dismissedCount = outcome.totalMatches - pendingMatches;
    return (
      <span>
        {outcome.totalMatches} in {outcome.files.length} file
        {outcome.files.length === 1 ? "" : "s"}
        {dismissedCount > 0 && ` · ${dismissedCount} dismissed`}
        {outcome.truncated && " · capped"}
      </span>
    );
  };

  return (
    <div className="sidebar-section" style={{ flex: 1 }}>
      <div
        className="pane-header"
        onContextMenu={(event) => menu.openContextMenu(event, paneEntries())}
      >
        <FindReplaceIcon />
        <span className="pane-title">Find &amp; Replace</span>
        <div className="actions">
          <button
            className="toggle-button icon-button"
            onClick={() => void run(query)}
            disabled={!query || busy || writing}
            title="Search again"
          >
            <RefreshIcon />
          </button>
        </div>
      </div>

      <div
        className="search-form"
        onContextMenu={(event) =>
          menu.openContextMenu(event, [...paneEntries(), "separator", "editing"])
        }
      >
        <div className="search-row">
          <input
            ref={queryRef}
            className="search-input"
            value={query}
            placeholder="Find in repository"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setQuery("");
              } else if (event.key === "Enter") {
                // The one way past the two-character guard, and the way to redo
                // a sweep the tree has changed under.
                event.preventDefault();
                forced.current = query;
                void run(query);
              }
            }}
          />
          <div className="search-toggles">
            <button
              className="toggle-button"
              data-active={caseSensitive}
              onClick={() => setCaseSensitive((v) => !v)}
              title="Match case"
            >
              Aa
            </button>
            <button
              className="toggle-button"
              data-active={wholeWord}
              onClick={() => setWholeWord((v) => !v)}
              title="Match whole word"
            >
              ab
            </button>
            <button
              className="toggle-button"
              data-active={useRegex}
              onClick={() => setUseRegex((v) => !v)}
              title="Regular expression — $1 in the replacement is a capture group"
            >
              .*
            </button>
          </div>
        </div>

        <div className="search-row">
          <input
            className="search-input"
            value={replacement}
            placeholder="Replace with"
            spellCheck={false}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setReplacement("");
              } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                replaceAll();
              }
            }}
            title="Empty deletes the matched text. Ctrl+Enter replaces everything listed."
          />
          <button
            className="toggle-button"
            onClick={replaceAll}
            disabled={writing || busy || pendingMatches === 0}
            title={
              pendingMatches === 0
                ? "Nothing to replace"
                : `Replace ${pendingMatches} match(es) in ${pending.length} file(s)`
            }
          >
            <FindReplaceIcon /> All
          </button>
        </div>

        <button
          className="search-filters-toggle"
          onClick={() => setFiltersOpen((v) => !v)}
          title="Limit the sweep to, or away from, a set of paths"
        >
          <span className="twisty">{filtersOpen ? "▾" : "▸"}</span>
          files to include / exclude
          {!filtersOpen && (include || exclude) && <span className="badge">set</span>}
        </button>
        {filtersOpen && (
          <>
            <input
              className="search-input"
              value={include}
              placeholder="Include, e.g. src/**, *.ts"
              spellCheck={false}
              onChange={(event) => setInclude(event.target.value)}
            />
            <input
              className="search-input"
              value={exclude}
              placeholder="Exclude, e.g. dist/**, *.lock"
              spellCheck={false}
              onChange={(event) => setExclude(event.target.value)}
            />
          </>
        )}
      </div>

      {(busy || writing || error || note || outcome || query.length > 0) && (
        <div className="pane-search-note">{summary()}</div>
      )}

      <div
        className="pane-body"
        onContextMenu={(event) =>
          menu.openContextMenu(event, [...paneEntries(), "separator", "app"])
        }
      >
        {!root && <div className="empty-note">Open a repository to search it.</div>}
        {root && !outcome && !busy && !error && query === "" && (
          <div className="empty-note">
            Type to search every file the Explorer would show. Gitignored paths are skipped.
          </div>
        )}
        {files.map((file) => {
          const isCollapsed = collapsed.has(file.path);
          const live = file.matches.filter(
            (hit) => !dismissed.has(matchKey(file.path, hit)),
          );
          const directory = parentDir(file.relative);
          return (
            <div key={file.path}>
              <div
                className="row search-file-row"
                data-empty={live.length === 0}
                title={file.path}
                onClick={() => toggleFile(file.path)}
                onContextMenu={(event) => menu.openContextMenu(event, fileMenu(file))}
              >
                <span className="twisty">{isCollapsed ? "▸" : "▾"}</span>
                <span className="label">{baseName(file.relative)}</span>
                {directory && <span className="search-dir">{directory}</span>}
                <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                  <button
                    className="toggle-button icon-button"
                    title={`Replace ${live.length} match(es) in this file`}
                    disabled={writing || busy || live.length === 0}
                    onClick={() => replaceInFile(file)}
                  >
                    <FindReplaceIcon />
                  </button>
                  <button
                    className="toggle-button icon-button"
                    title="Dismiss this file — its matches are left alone"
                    disabled={live.length === 0}
                    onClick={() => dismissFile(file)}
                  >
                    <ClearIcon />
                  </button>
                </div>
                <span className="count">
                  {live.length}
                  {file.truncated && "+"}
                </span>
              </div>
              {!isCollapsed &&
                file.matches.map((hit) => {
                  const gone = dismissed.has(matchKey(file.path, hit));
                  return (
                    <div
                      key={`${hit.start}`}
                      className="search-match-row"
                      data-dismissed={gone}
                      title={`${file.relative}:${hit.line}:${hit.column}`}
                      onClick={() => onOpenMatch(file.path, hit.line, hit.column)}
                      onContextMenu={(event) =>
                        menu.openContextMenu(event, matchMenu(file, hit))
                      }
                    >
                      <span className="match-line">{hit.line}</span>
                      <span className="match-text">
                        {hit.before}
                        <mark className="search-hit" data-replaced={previewable}>
                          {hit.matched}
                        </mark>
                        {previewable && <mark className="search-new">{replacement}</mark>}
                        {hit.after}
                      </span>
                      <div
                        className="row-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          className="toggle-button icon-button"
                          title="Dismiss this match"
                          disabled={gone}
                          onClick={() => dismissMatch(file.path, hit)}
                        >
                          <ClearIcon />
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
        {outcome?.truncated && files.length > 0 && (
          <div className="empty-note">
            Capped at {MATCH_BUDGET} matches. Narrow the query, or use the include box.
          </div>
        )}
      </div>
    </div>
  );
});
