import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { copyText } from "../lib/editing";
import { BranchIcon, FetchIcon, PlusIcon } from "../lib/icons";
import {
  gitBranchList,
  gitCheckout,
  gitCreateBranch,
  gitDirty,
  gitFetch,
  gitPull,
  gitTracking,
} from "../lib/ipc";
import { useMenu } from "../lib/menu";
import type { BranchList } from "../lib/types";
import {
  branchLabel,
  canFastForward,
  describeNews,
  newsKey,
  syncAction,
  syncCounts,
  syncTitle,
  trackingTitle,
  upstreamNews,
  type Tracking,
  type UpstreamNews,
} from "../lib/upstream";

/**
 * How often the branch and its counts are re-read from refs on disk.
 *
 * Frequent, because it is what makes the chip agree with a checkout or a commit
 * made anywhere else — Source Control, a terminal tab, a session's own `git`.
 * Affordable at this rate only because `gitTracking` reads refs and never walks
 * the worktree; a `git status` poll on a monorepo would be a stutter every tick.
 */
const READ_MS = 5_000;

/**
 * How often the remote is asked whether there is anything new.
 *
 * This one is a network call, so it is rare, and it is the only reason the
 * counts can move on their own: `behind` is a fact about the last fetch, not
 * about the server. Five minutes is slow enough to be invisible on a phone
 * tether and fast enough that "you should pull" arrives while it still matters.
 */
const FETCH_MS = 5 * 60_000;

/**
 * How often the `*` beside the branch is re-checked.
 *
 * Slower than the branch itself, because unlike `gitTracking` this one has to
 * compare tracked files against HEAD — the cheaper half of a status, but still
 * a walk. The marker says "you have uncommitted work", which is not a fact that
 * needs to be a second old.
 */
const DIRTY_MS = 10_000;

/**
 * What the chip last said about each repo, kept for the life of the window.
 *
 * A repo switch used to blank the chip and wait for a fresh `gitTracking`: the
 * branch name vanished from the status bar and came back a moment later, which
 * on the way back to a repo you were in a minute ago is a flicker with nothing
 * behind it. Seeded from here instead, the switch shows the branch that repo had
 * while the read that confirms it is still in flight.
 *
 * Module-level rather than state, because the component is one instance whose
 * `cwd` changes — there is nowhere else for a per-repo memory to live.
 */
const lastSeen = new Map<string, { tracking: Tracking; dirty: boolean }>();

/**
 * When each repo's remote was last asked, so a switch does not re-fetch.
 *
 * The network check announces on the repo opening, which made every visit to a
 * repo — including flicking between two of them — spawn a `git fetch`. One per
 * repo per `FETCH_MS` is what the interval already promises; this holds the
 * promise across switches.
 */
const lastFetched = new Map<string, number>();

interface BranchStatusProps {
  /** The repo the strip is showing. Empty outside a repo. */
  cwd: string;
  /**
   * Fetch in the background, and interrupt when there is something to pull.
   *
   * Off means the chip still tracks refs on disk — it just never reaches the
   * network, so the counts only move when something else fetches.
   */
  watch: boolean;
  /** Bumped after a pull, so panes reading the same repo re-read it. */
  onChanged: () => void;
  /** Where a failure that has no dialog to live in goes. */
  onNotice: (message: string) => void;
}

/**
 * The branch, what it owes its upstream, and one click to take it.
 *
 * Lives in the status bar because that is where "which branch am I on" is
 * asked, and asked while looking at something else — the Source Control pane
 * answers it too, but only while it is the pane you have open.
 *
 * Everything shown is read from git rather than remembered: a checkout in a
 * terminal tab, a commit from a session, a pull in the sidebar all move these
 * numbers without telling this component, so it re-reads instead of tracking.
 */
export function BranchStatus({ cwd, watch, onChanged, onNotice }: BranchStatusProps) {
  const menu = useMenu();
  const [tracking, setTracking] = useState<Tracking | null>(
    () => lastSeen.get(cwd)?.tracking ?? null,
  );
  const [busy, setBusy] = useState<"fetch" | "pull" | "switch" | null>(null);
  /** Whether the branch picker is open, and what it has to offer. */
  const [picking, setPicking] = useState(false);
  const [branches, setBranches] = useState<BranchList | null>(null);
  const [filter, setFilter] = useState("");
  /** The news a dialog is currently asking about, with its own error and result. */
  const [prompt, setPrompt] = useState<UpstreamNews | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  /** Whether anything is uncommitted: the `*` VSCode puts beside the branch. */
  const [dirty, setDirty] = useState(() => lastSeen.get(cwd)?.dirty ?? false);

  /**
   * News already put to the user, so the same commits are not raised twice.
   *
   * A ref rather than state: nothing renders from it, and it must not be a dep
   * of the poller — a dismissal that restarted the timers would re-ask.
   *
   * Not persisted, deliberately. Once per run of the app is where a reminder
   * stops being a reminder and starts being furniture; a fresh launch asking
   * again is the whole point of asking at all.
   */
  const asked = useRef<Set<string>>(new Set());

  /**
   * Bumped per repo change, so a slow read for the previous repo is dropped.
   *
   * A fetch can take seconds on a bad connection, which is long enough to land
   * after the user has moved to another repo — and its counts would be that
   * repo's counts under this repo's name.
   */
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    const seen = lastSeen.get(cwd);
    setTracking(seen?.tracking ?? null);
    setDirty(seen?.dirty ?? false);
    setBusy(null);
    setPrompt(null);
    setPromptError(null);
    setPicking(false);
    setBranches(null);
  }, [cwd]);

  /**
   * Re-read refs. `announce` also decides whether to interrupt with the result.
   *
   * Only the automatic checks announce: a read the user asked for is a read they
   * are already looking at, and a dialog on top of their own click is a dialog
   * telling them what they just did.
   */
  const read = useCallback(
    async (announce: boolean) => {
      if (!cwd) return;
      const mine = generation.current;
      try {
        const next = await gitTracking(cwd);
        if (mine !== generation.current) return;
        setTracking(next);
        lastSeen.set(cwd, { tracking: next, dirty: lastSeen.get(cwd)?.dirty ?? false });
        if (!announce) return;
        const news = upstreamNews(next);
        if (!news) return;
        const key = newsKey(cwd, news);
        if (asked.current.has(key)) return;
        asked.current.add(key);
        setPromptError(null);
        setPrompt(news);
      } catch {
        // Not a repo, or git is missing — `App` already has nowhere to put a
        // repo it cannot read, and the chip simply says nothing.
        if (mine === generation.current) setTracking(null);
      }
    },
    [cwd],
  );

  /** Ask the remote, then re-read. Failures here are silent by design. */
  const check = useCallback(
    async (announce: boolean) => {
      if (!cwd) return;
      const mine = generation.current;
      // Stamped before the call, not after: a fetch that takes ten seconds must
      // not leave the door open for a second one behind it.
      lastFetched.set(cwd, Date.now());
      setBusy("fetch");
      try {
        await gitFetch(cwd);
      } catch {
        // A background fetch fails for reasons that are not the user's problem
        // right now: offline, no credential helper, a lock held by their own
        // git. None of them is worth a dialog they did not open, and the next
        // tick tries again.
      } finally {
        if (mine === generation.current) setBusy(null);
      }
      await read(announce);
    },
    [cwd, read],
  );

  /**
   * Fast-forward the branch onto its upstream.
   *
   * `--ff-only`, as in Source Control: a pull that has to merge, in a worktree
   * the user may be mid-edit in, is exactly where an implicit merge commit is
   * the wrong answer. Diverged branches are not offered this at all.
   */
  const pull = useCallback(
    async (report: (message: string) => void) => {
      if (!cwd) return;
      const mine = generation.current;
      setBusy("pull");
      try {
        await gitPull(cwd);
        if (mine !== generation.current) return;
        setPrompt(null);
        setPromptError(null);
        // The worktree just changed under every pane reading this repo.
        onChanged();
      } catch (e) {
        // git's own words: a rejected pull explains itself better than any
        // wording here would — a dirty file it would overwrite, a diverged
        // branch, a credential helper that is not configured.
        if (mine === generation.current) report(String(e));
      } finally {
        if (mine === generation.current) setBusy(null);
      }
      await read(false);
    },
    [cwd, onChanged, read],
  );

  /**
   * Open the picker and re-read the branch list.
   *
   * Read per open rather than kept: a fetch, a push from a session, a branch
   * created in a terminal tab all change what the list should say, and a list
   * from five minutes ago is a list missing the branch you came here for.
   */
  const openPicker = useCallback(() => {
    if (!cwd) return;
    setFilter("");
    setBranches(null);
    setPicking(true);
    const mine = generation.current;
    void gitBranchList(cwd)
      .then((next) => {
        if (mine === generation.current) setBranches(next);
      })
      .catch((e) => {
        if (mine !== generation.current) return;
        setPicking(false);
        onNotice(String(e));
      });
  }, [cwd, onNotice]);

  /**
   * Switch to a branch, or create one.
   *
   * Nothing is discarded on the way: `git switch` refuses a checkout that would
   * overwrite worktree changes, and its refusal is what the notice carries. The
   * whole workbench re-reads afterwards — every pane showing this repo is now
   * showing a different tree.
   */
  const move = useCallback(
    async (what: "switch" | "create", name: string) => {
      if (!cwd) return;
      const mine = generation.current;
      setPicking(false);
      setBusy("switch");
      try {
        await (what === "create" ? gitCreateBranch(cwd, name) : gitCheckout(cwd, name));
        if (mine !== generation.current) return;
        onChanged();
      } catch (e) {
        if (mine === generation.current) onNotice(String(e));
      } finally {
        if (mine === generation.current) setBusy(null);
      }
      await read(false);
    },
    [cwd, onChanged, onNotice, read],
  );

  /** Local branches first, then remote-tracking ones, filtered as you type. */
  const rows = useMemo(() => {
    if (!branches) return [];
    const query = filter.trim().toLowerCase();
    const all = [
      ...branches.local.map((name) => ({ name, remote: false })),
      ...branches.remote.map((name) => ({ name, remote: true })),
    ];
    return query ? all.filter((row) => row.name.toLowerCase().includes(query)) : all;
  }, [branches, filter]);

  /** Offered only when what was typed is not already a branch. */
  const creatable = filter.trim().length > 0 && !rows.some((row) => row.name === filter.trim());

  // Refs on disk, polled. Cheap enough to run whenever the window is on screen,
  // and pointless when it is not.
  useEffect(() => {
    if (!cwd) return;
    void read(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read(false);
    }, READ_MS);
    return () => window.clearInterval(timer);
  }, [cwd, read]);

  /*
   * The `*`, on its own slower clock.
   *
   * Separate from the refs poll rather than folded into it: this read walks
   * tracked files and that one does not, so putting them on the same tick would
   * make the cheap read cost what the expensive one does.
   */
  useEffect(() => {
    if (!cwd) return;
    const mine = generation.current;
    const look = () => {
      void gitDirty(cwd)
        .then((next) => {
          const seen = lastSeen.get(cwd);
          if (seen) lastSeen.set(cwd, { ...seen, dirty: next });
          if (mine === generation.current) setDirty(next);
        })
        .catch(() => {});
    };
    look();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") look();
    }, DIRTY_MS);
    return () => window.clearInterval(timer);
  }, [cwd]);

  /*
   * The network half: once when the repo opens, then on a long interval.
   *
   * Only the open announces. Opening a repo is the moment the question "is there
   * anything to pull" is worth interrupting for — it is the moment before you
   * start working, which is the only moment pulling is free. Every later tick
   * lands mid-work, where a dialog over the thing you are reading costs more
   * than it tells you; those move the counts and light the button instead, and
   * the button is the notification.
   */
  useEffect(() => {
    if (!cwd || !watch) return;
    // "Once when the repo opens" means once per repo, not once per visit: coming
    // back to a repo whose remote was asked a moment ago has nothing to learn,
    // and the child process it spawned was part of what made a switch drag.
    if (Date.now() - (lastFetched.get(cwd) ?? 0) >= FETCH_MS) void check(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check(false);
    }, FETCH_MS);
    return () => window.clearInterval(timer);
  }, [cwd, watch, check]);

  const label = branchLabel(tracking);
  if (!label) return null;

  const news = upstreamNews(tracking);
  const ready = canFastForward(tracking);
  const counts = syncCounts(tracking);
  const action = syncAction(tracking);

  /** The sync item's click, which is only ever the safe half of a sync. */
  const sync = () => {
    if (action === "pull") return void pull(onNotice);
    // Diverged: the dialog explains, because the answer is a merge or a rebase
    // and neither is a decision a status-bar button should make.
    if (action === "explain" && news) {
      setPromptError(null);
      setPrompt(news);
      return;
    }
    void check(false);
  };

  return (
    <>
      {/* Branch first and leftmost, as VSCode puts it — this is the item the eye
          goes to, and everything after it is context for it. A button, and one
          click switches branch: the chip is where the question "which branch am
          I on" is asked, and "put me on another one" is the same question. */}
      <span className="status-branch-slot">
        <button
          className="status-branch"
          disabled={busy === "switch"}
          title={
            busy === "switch" ? "Switching branch…" : `${trackingTitle(tracking)}\nSwitch branch`
          }
          onClick={() => (picking ? setPicking(false) : openPicker())}
          onContextMenu={(event) =>
            menu.openContextMenu(event, [
              {
                label: "Switch Branch…",
                disabled: busy !== null,
                run: openPicker,
              },
              { label: "Copy Branch", run: () => void copyText(label.text) },
              {
                label: busy === "fetch" ? "Fetching…" : "Fetch Now",
                disabled: busy !== null,
                run: () => void check(false),
              },
              news && {
                label: `Pull (${describeNews(news)})`,
                disabled: busy !== null || !ready,
                run: () => void pull(onNotice),
              },
            ])
          }
        >
          <BranchIcon />
          <span className="status-branch-name">{label.text}</span>
          {/* Uncommitted work, in one character, exactly where VSCode puts it. */}
          {dirty && (
            <span className="status-branch-dirty" title="Uncommitted changes">
              *
            </span>
          )}
        </button>

        {picking && (
          <BranchPicker
            rows={rows}
            current={branches?.current ?? null}
            loading={branches === null}
            filter={filter}
            creatable={creatable}
            onFilter={setFilter}
            onPick={(name) => void move("switch", name)}
            onCreate={(name) => void move("create", name)}
            onClose={() => setPicking(false)}
          />
        )}
      </span>

      {/* One item carrying the glyph and both counts, as VSCode arranges it,
          rather than a labelled button. Shown whenever there is an upstream: "in
          sync" is worth being able to see, and the click is useful in every
          state — see `syncAction`. */}
      {tracking?.upstream && (
        <button
          className="status-sync"
          data-action={action}
          data-busy={busy !== null}
          disabled={busy !== null}
          title={busy === "pull" ? "Pulling…" : syncTitle(tracking)}
          onClick={sync}
        >
          <FetchIcon className={busy === "fetch" ? "status-spinning" : undefined} />
          {counts && <span className="status-sync-counts">{counts}</span>}
        </button>
      )}

      {prompt && (
        <PullPrompt
          news={prompt}
          ahead={tracking?.ahead ?? 0}
          branch={label.text}
          busy={busy === "pull"}
          error={promptError}
          onPull={() => void pull(setPromptError)}
          onClose={() => setPrompt(null)}
        />
      )}
    </>
  );
}

interface BranchRow {
  name: string;
  remote: boolean;
}

interface BranchPickerProps {
  rows: BranchRow[];
  /** The branch HEAD is on, ticked in the list. */
  current: string | null;
  /** True until the list has arrived, which is a round trip to git. */
  loading: boolean;
  filter: string;
  creatable: boolean;
  onFilter: (value: string) => void;
  onPick: (name: string) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}

/**
 * The branch list, above the chip that opened it.
 *
 * A popover rather than the context menu the chip also has: branch lists run to
 * dozens of entries on a repo anyone works in, and a menu with no filter is a
 * scroll. Same shape as the Source Control pane's picker — filter on top,
 * scrolling list under it, typing a name that does not exist offers to create
 * it — because it is the same job, asked from somewhere else.
 */
function BranchPicker({
  rows,
  current,
  loading,
  filter,
  creatable,
  onFilter,
  onPick,
  onCreate,
  onClose,
}: BranchPickerProps) {
  // On the window rather than on the input: the click that opened this left
  // focus on the chip, and Escape has to close it from there too.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  /** Enter takes the first match, or creates what was typed when there is none. */
  const submit = () => {
    if (rows.length > 0) return onPick(rows[0].name);
    if (creatable) onCreate(filter.trim());
  };

  return (
    <>
      {/* Invisible, and only there to catch the click that dismisses. Mousedown
          rather than click, so a press outside closes before it lands on
          whatever is under it. */}
      <div
        className="popover-scrim"
        onMouseDown={(event) => event.button === 0 && onClose()}
        onContextMenu={onClose}
      />
      <div className="branch-popover">
        <input
          className="branch-filter"
          autoFocus
          placeholder="Switch to or create…"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <div className="branch-list">
          {creatable && (
            <div className="row" onClick={() => onCreate(filter.trim())}>
              <PlusIcon />
              <span className="label">Create branch “{filter.trim()}”</span>
            </div>
          )}
          {rows.map((row) => (
            <div
              key={`${row.remote ? "r" : "l"}:${row.name}`}
              className="row"
              data-selected={row.name === current}
              onClick={() => onPick(row.name)}
            >
              <BranchIcon />
              <span className="label">{row.name}</span>
              {row.remote && <span className="badge">remote</span>}
            </div>
          ))}
          {rows.length === 0 && !creatable && (
            <div className="empty-note">{loading ? "Reading branches…" : "No matching branch."}</div>
          )}
        </div>
      </div>
    </>
  );
}

interface PullPromptProps {
  news: UpstreamNews;
  ahead: number;
  branch: string;
  busy: boolean;
  error: string | null;
  onPull: () => void;
  onClose: () => void;
}

/**
 * The offer, raised when a repo opens with commits waiting on its upstream.
 *
 * A dialog rather than a badge because the point in time it is worth saying is
 * *before* you start working: pulling after an hour of edits is a rebase, and
 * pulling before them is nothing at all. It says it once per set of commits —
 * see `asked` above — so it can afford to be a dialog.
 */
function PullPrompt({
  news,
  ahead,
  branch,
  busy,
  error,
  onPull,
  onClose,
}: PullPromptProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="quickopen-scrim" onMouseDown={(event) => event.button === 0 && onClose()}>
      <div className="settings pull-prompt" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pane-header">
          <span>Upstream changes</span>
          <div className="actions">
            <button className="toggle-button" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        <div className="pull-prompt-body">
          <p>
            <code>{branch}</code> is {describeNews(news)}.
          </p>
          {news.diverged ? (
            <p className="setting-hint">
              You also have {ahead === 1 ? "1 commit" : `${ahead} commits`} the upstream does
              not, so a fast-forward is not possible — reconciling the two is a merge or a
              rebase, and which one it should be is not a choice this dialog gets to make.
              Source Control has both.
            </p>
          ) : (
            <p className="setting-hint">
              Fast-forward only, so nothing of yours is merged or rewritten. A worktree edit
              that would be overwritten stops the pull instead, with git's own message.
            </p>
          )}
          {error && <p className="pull-prompt-error">{error}</p>}
        </div>

        <div className="pull-prompt-actions">
          <button className="secondary-button" onClick={onClose}>
            {news.diverged ? "Close" : "Not now"}
          </button>
          {!news.diverged && (
            <button className="primary-button" disabled={busy} onClick={onPull}>
              {busy ? "Pulling…" : "Pull"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
