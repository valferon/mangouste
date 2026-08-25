import { useCallback, useEffect, useRef, useState } from "react";

import { copyText } from "../lib/editing";
import { BranchIcon, FetchIcon, PullIcon } from "../lib/icons";
import { gitFetch, gitPull, gitTracking } from "../lib/ipc";
import { useMenu } from "../lib/menu";
import {
  branchLabel,
  canFastForward,
  describeNews,
  newsKey,
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
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [busy, setBusy] = useState<"fetch" | "pull" | null>(null);
  /** The news a dialog is currently asking about, with its own error and result. */
  const [prompt, setPrompt] = useState<UpstreamNews | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);

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
    setTracking(null);
    setBusy(null);
    setPrompt(null);
    setPromptError(null);
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
    void check(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check(false);
    }, FETCH_MS);
    return () => window.clearInterval(timer);
  }, [cwd, watch, check]);

  const label = branchLabel(tracking);
  if (!label) return null;

  const news = upstreamNews(tracking);
  const ready = canFastForward(tracking);

  return (
    <>
      <span
        className="status-branch"
        title={trackingTitle(tracking)}
        onContextMenu={(event) =>
          menu.openContextMenu(event, [
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
        {/* Only counts that are non-zero: a row of zeroes is four characters
            saying nothing, every second of every day. */}
        {tracking && tracking.ahead > 0 && <span className="status-ahead">↑{tracking.ahead}</span>}
        {tracking && tracking.behind > 0 && (
          <span className="status-behind">↓{tracking.behind}</span>
        )}
        {busy === "fetch" && <FetchIcon className="status-checking" />}
      </span>

      {/* The button appears only when it has something to do. A pull that is
          permanently greyed out is furniture; one that shows up when commits
          land is the notification. */}
      {news && (
        <button
          className="status-pull"
          data-diverged={news.diverged}
          disabled={busy !== null}
          title={
            news.diverged
              ? `${describeNews(news)}, and ${tracking?.ahead} of yours it does not have — a fast-forward is not possible`
              : `Pull ${describeNews(news)}`
          }
          onClick={() => {
            // Diverged: the dialog explains, because the answer is a merge or a
            // rebase and neither is a decision a status-bar button should make.
            if (news.diverged) {
              setPromptError(null);
              setPrompt(news);
              return;
            }
            void pull(onNotice);
          }}
        >
          <PullIcon />
          {busy === "pull" ? "pulling…" : news.diverged ? "diverged" : "pull"}
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
