/**
 * A session's work on the code, as a diff, while it is still being done.
 *
 * The chat already shows every `Edit` as its own card, which is the right thing
 * when you are reading one turn and the wrong thing when you are watching a
 * session run: the cards are scattered through pages of tool output, three
 * attempts at one line read as three changes, and anything done through `Bash`
 * — a `sed`, a formatter, a codegen step — leaves no card at all. This pane
 * answers the other question. Not "what did it say it would do", but "what does
 * the code say now, compared to where this session started".
 *
 * Everything here comes off disk through git (`session_changes`), narrowed to
 * the paths this session's transcript says it wrote. That narrowing is also the
 * one thing this cannot do perfectly: git knows a file changed, not who changed
 * it, so a file two sessions are both editing shows both their work.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  countsLabel,
  filesInScope,
  sameChanges,
  scopeOptions,
  scopeSince,
  summaryLabel,
  totals,
  type ChangeScope,
} from "../lib/changes";
import { copyText } from "../lib/editing";
import { RefreshIcon } from "../lib/icons";
import { onSessionsChanged, revealPath, sessionChangePatch, sessionChanges } from "../lib/ipc";
import { useMenu, type MenuEntry } from "../lib/menu";
import { baseName, parentDir } from "../lib/paths";
import type { ChangedFile, SessionChanges } from "../lib/types";
import { DiffView } from "./Viewer";

/**
 * How often the scan re-runs while the pane is open.
 *
 * A `git diff --numstat` over one session's paths, plus an incremental fold of
 * whatever the transcript appended — cheap enough to sit at watching speed. A
 * turn that edits a file every few seconds should make the row move while you
 * are looking at it, or the pane is a stale report rather than a window.
 */
const POLL_MS = 3_000;

/** Patches held in memory at once, across every file the pane has opened. */
const PATCH_CACHE = 12;

export interface ChangesPaneProps {
  /** The session's repo, which is what git is asked about. */
  cwd: string;
  /** Transcript path, which is what the write-set is folded from. */
  file: string;
  /** The read watermark, for the "since I last looked" scope. */
  seenAtMs: number;
  /** A hidden pane neither polls nor fetches; the tab stays mounted regardless. */
  visible: boolean;
}

/** `2m ago`, or nothing at all when the transcript could not date the write. */
function agoLabel(atMs: number, now: number): string | null {
  if (atMs <= 0) return null;
  const seconds = Math.max(0, Math.round((now - atMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const FileRow = memo(function FileRow({
  file,
  selected,
  onSelect,
  onMenu,
  now,
}: {
  file: ChangedFile;
  selected: boolean;
  onSelect: () => void;
  onMenu: (event: React.MouseEvent) => void;
  now: number;
}) {
  const folder = parentDir(file.path);
  const ago = agoLabel(file.lastTouchMs, now);
  return (
    <div
      className="row changes-row"
      data-selected={selected}
      onClick={onSelect}
      onContextMenu={onMenu}
      title={file.path}
    >
      <span className="label">{baseName(file.path)}</span>
      {folder && folder !== file.path && <span className="scm-dir">{folder}</span>}
      {file.untracked && <span className="badge">new</span>}
      {/* A file git found that no write tool named: a `sed`, a formatter, a
          build step. Worth marking, because it is the class of change the chat
          transcript cannot show at all. */}
      {file.touches === 0 && !file.untracked && (
        <span className="badge" title="Changed on disk, but no edit tool named it">
          on disk
        </span>
      )}
      {ago !== null && <span className="changes-ago">{ago}</span>}
      <span className="changes-counts">
        {file.additions === null && file.deletions === null ? (
          <span className="changes-binary">binary</span>
        ) : (
          <>
            <span className="changes-add">+{file.additions ?? 0}</span>
            <span className="changes-del">−{file.deletions ?? 0}</span>
          </>
        )}
      </span>
    </div>
  );
});

export default function ChangesPane({ cwd, file, seenAtMs, visible }: ChangesPaneProps) {
  const menu = useMenu();
  const [changes, setChanges] = useState<SessionChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<ChangeScope>("session");
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  /**
   * Keep the newest-written file selected as the session works.
   *
   * On by default: the pane exists to be watched, and one that holds still while
   * the session moves is one you have to keep clicking. Any click turns it off —
   * a deliberate choice of file outranks the follow.
   */
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  /** Patch bytes, keyed by path *and* the state they were fetched at. */
  const patches = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    try {
      const next = await sessionChanges(cwd, file);
      setError(null);
      // Identity is what the list, the selection and the open patch are keyed
      // on, so a poll that found nothing new must not produce a new object.
      setChanges((current) => (sameChanges(current, next) ? current : next));
    } catch (e) {
      setError(String(e));
    }
  }, [cwd, file]);

  // Two triggers, and both are needed: the event fires when a scan notices the
  // transcript moved, which is most changes, and the timer covers the rest — a
  // file written by a `Bash` call the transcript only records on completion.
  useEffect(() => {
    if (!visible) return;
    void load();
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void load();
    }, POLL_MS);
    let unlisten: (() => void) | null = null;
    void onSessionsChanged(() => void load()).then((off) => {
      unlisten = off;
    });
    return () => {
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [load, visible]);

  const clock = useMemo(
    () => ({ turnStartMs: changes?.turnStartMs ?? 0, seenAtMs }),
    [changes?.turnStartMs, seenAtMs],
  );
  const options = useMemo(() => scopeOptions(clock), [clock]);
  const shown = useMemo(
    () => filesInScope(changes?.files ?? [], scopeSince(scope, clock)),
    [changes, scope, clock],
  );
  const sum = useMemo(() => totals(shown), [shown]);

  // A scope whose clock went away — a session read for the first time, a turn
  // that has not started — must not leave the pane showing an empty list under
  // a control the user can no longer reach.
  useEffect(() => {
    const option = options.find((entry) => entry.scope === scope);
    if (option?.disabled === true) setScope("session");
  }, [options, scope]);

  /** The newest write in the current scope, which is what follow mode tracks. */
  const newest = shown.length > 0 ? shown[0].path : null;
  useEffect(() => {
    if (follow && newest !== null) setSelected(newest);
  }, [follow, newest]);

  // Nothing selected, or a selection the current scope no longer lists.
  useEffect(() => {
    if (shown.length === 0) {
      setSelected(null);
      return;
    }
    if (selected === null || !shown.some((entry) => entry.path === selected)) {
      setSelected(shown[0].path);
    }
  }, [shown, selected]);

  const current = shown.find((entry) => entry.path === selected) ?? null;
  const base = changes?.base ?? "";
  // Keyed on what the patch is *of*: the same path at the same baseline with the
  // same counts is the same bytes, so a poll does not re-fetch it — and a write
  // that moved the counts does.
  const patchKey =
    current === null
      ? null
      : [base, current.path, current.additions, current.deletions, current.lastTouchMs].join("|");

  useEffect(() => {
    if (!visible || current === null || patchKey === null || base === "") return;
    const cached = patches.current.get(patchKey);
    if (cached !== undefined) {
      setPatch(cached);
      setPatchError(null);
      return;
    }
    let cancelled = false;
    void sessionChangePatch(cwd, base, current.path, current.untracked)
      .then((text) => {
        if (cancelled) return;
        patches.current.set(patchKey, text);
        // Oldest key first, which for a Map is insertion order.
        if (patches.current.size > PATCH_CACHE) {
          const oldest = patches.current.keys().next().value;
          if (oldest !== undefined) patches.current.delete(oldest);
        }
        setPatch(text);
        setPatchError(null);
      })
      .catch((e) => {
        if (!cancelled) {
          setPatch(null);
          setPatchError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [base, cwd, current, patchKey, visible]);

  const fileMenu = useCallback(
    (entry: ChangedFile): MenuEntry[] => [
      { header: entry.path },
      { label: "Copy Path", run: () => void copyText(entry.path) },
      { label: "Reveal in File Manager", run: () => void revealPath(`${cwd}/${entry.path}`) },
      "separator",
      { label: "Refresh", run: () => void load() },
    ],
    [cwd, load],
  );

  const pick = useCallback((path: string) => {
    // An explicit click is a decision to read that file, and following would
    // take it away again on the next write.
    setFollow(false);
    setSelected(path);
  }, []);

  return (
    <div className="changes-pane">
      <div className="pane-header">
        <span className="pane-title">Changes</span>
        <span className="count" title={changes === null ? undefined : `against ${changes.base}`}>
          {changes === null ? "scanning…" : summaryLabel(sum)}
        </span>
        <div className="actions">
          <button
            className="toggle-button"
            data-active={follow}
            onClick={() => setFollow((on) => !on)}
            title="Keep the newest edited file selected as the session works"
          >
            follow
          </button>
          <button className="toggle-button icon-button" onClick={() => void load()} title="Refresh">
            <RefreshIcon />
          </button>
        </div>
      </div>

      <div className="changes-scopes">
        {options.map((option) => (
          <button
            key={option.scope}
            className="toggle-button"
            data-active={scope === option.scope}
            disabled={option.disabled}
            title={option.title}
            onClick={() => setScope(option.scope)}
          >
            {option.label}
          </button>
        ))}
        {changes !== null && (
          <span className="changes-base" title={`Diffed against ${changes.base}`}>
            vs {changes.baseLabel}
          </span>
        )}
      </div>

      {error !== null && <div className="empty-note">{error}</div>}

      {error === null && changes !== null && shown.length === 0 && (
        <div className="empty-note">
          {changes.fileCount === 0
            ? changes.unchanged > 0
              ? `This session wrote ${changes.unchanged} file${
                  changes.unchanged === 1 ? "" : "s"
                }, and every one of them is back where it started.`
              : "This session has not changed any code yet."
            : "Nothing in this scope. The session's earlier work is under “session”."}
        </div>
      )}

      {shown.length > 0 && (
        <>
          <div className="changes-list">
            {shown.map((entry) => (
              <FileRow
                key={entry.path}
                file={entry}
                selected={entry.path === selected}
                now={now}
                onSelect={() => pick(entry.path)}
                onMenu={(event) => menu.openContextMenu(event, fileMenu(entry))}
              />
            ))}
            {changes !== null && changes.fileCount > changes.files.length && (
              <div className="empty-note">
                … and {(changes.fileCount - changes.files.length).toLocaleString()} more files
              </div>
            )}
          </div>

          <div className="changes-diff">
            {current !== null && (
              <div className="changes-diff-head">
                <span className="label">{current.path}</span>
                <span className="changes-counts">{countsLabel(totals([current]))}</span>
                {/* The patch is cumulative whatever the scope says, and a pane
                    that let you believe otherwise would be worse than one with
                    no scopes at all. */}
                {scope !== "session" && (
                  <span className="changes-note" title="A scope narrows which files are listed">
                    whole-session diff
                  </span>
                )}
              </div>
            )}
            {patchError !== null ? (
              <div className="empty-note">{patchError}</div>
            ) : patch === null ? (
              <div className="empty-note">Reading the patch…</div>
            ) : patch.trim() === "" ? (
              <div className="empty-note">No textual diff.</div>
            ) : (
              <DiffView patch={patch} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
