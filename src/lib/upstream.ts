/**
 * What the status bar says about the branch, and when it is worth interrupting.
 *
 * `git status --branch` reports ahead/behind against the remote-tracking ref as
 * it stood at the last fetch, so "behind" is only ever as fresh as the last time
 * something asked the remote. Fetching is therefore part of knowing, which is
 * why the poller below the UI does it — and why every count here is described as
 * a fact about refs on disk rather than as news from the server.
 *
 * The decisions are pure so they can be tested without a repo: which label the
 * chip carries, whether there is anything to pull, whether a fast-forward can
 * work at all, and whether this particular news has already been dismissed.
 */

import type { RepoStatus } from "./types";

/** The branch-tracking half of a status read. The files are somebody else's job. */
export type Tracking = Pick<RepoStatus, "branch" | "upstream" | "ahead" | "behind">;

/**
 * git's own wording for a detached HEAD, verbatim from the porcelain header.
 *
 * `## HEAD (no branch)` is a sentence, not a branch name, and printing it in a
 * chip that otherwise holds branch names reads as a branch called `HEAD`.
 */
const DETACHED = "HEAD (no branch)";

/**
 * git's wording before the first commit: `## No commits yet on main`.
 *
 * The branch is real and named — it just does not point at anything yet — so the
 * name is what the chip shows, and `unborn` is what says the rest.
 */
const NO_COMMITS = /^No commits yet on (.+)$/;

/** What the chip shows, and what the branch actually is. */
export interface BranchLabel {
  /** Text for the chip. Never one of git's sentences. */
  text: string;
  /** A detached HEAD: there is no branch to track anything. */
  detached: boolean;
  /** A branch with no commits on it yet. */
  unborn: boolean;
}

export function branchLabel(tracking: Tracking | null): BranchLabel | null {
  const branch = tracking?.branch;
  if (!branch) return null;
  if (branch === DETACHED) return { text: "detached", detached: true, unborn: false };
  const unborn = NO_COMMITS.exec(branch);
  if (unborn) return { text: unborn[1], detached: false, unborn: true };
  return { text: branch, detached: false, unborn: false };
}

/**
 * Commits on the upstream that are not here, and whether they can be taken.
 *
 * `null` when there is nothing to say: no upstream configured, or the branch is
 * level with it or ahead of it. Being ahead is not news — that is a push, and
 * pushing is not something this bar decides for you.
 */
export interface UpstreamNews {
  behind: number;
  /** The tracking ref, e.g. `origin/main`. Non-null whenever there is news. */
  upstream: string;
  /**
   * Both sides have commits the other does not, so a fast-forward cannot work.
   *
   * The only pull offered here is `--ff-only`, deliberately: reconciling a
   * diverged branch is a merge or a rebase, and neither is a thing a status-bar
   * button should pick on your behalf.
   */
  diverged: boolean;
}

export function upstreamNews(tracking: Tracking | null): UpstreamNews | null {
  if (!tracking?.upstream || tracking.behind <= 0) return null;
  return {
    behind: tracking.behind,
    upstream: tracking.upstream,
    diverged: tracking.ahead > 0,
  };
}

/** Whether a `--ff-only` pull has any chance of succeeding. */
export function canFastForward(tracking: Tracking | null): boolean {
  const news = upstreamNews(tracking);
  return news !== null && !news.diverged;
}

/** `3 commits behind origin/main`, and the singular of it. */
export function describeNews(news: UpstreamNews): string {
  const commits = news.behind === 1 ? "1 commit" : `${news.behind} commits`;
  return `${commits} behind ${news.upstream}`;
}

/**
 * Identity of one piece of news, so the same one is not raised twice.
 *
 * The count is part of it: dismissing "3 behind" says no to those three, and
 * says nothing about the two that land afterwards. The repo is part of it
 * because switching away and back is not a new event. Deliberately not
 * persisted — once per run of the app is the point at which a reminder stops
 * being a reminder and becomes furniture.
 *
 * Joined on NUL, written as an escape: it is the one byte that cannot appear in
 * a path or a ref name, so no combination of the three parts can collide with
 * another. As a literal it would make this file binary to git — no diffs, no
 * line history — which is a high price for a separator nobody reads.
 */
export function newsKey(cwd: string, news: UpstreamNews): string {
  return [cwd, news.upstream, news.behind].join("\u0000");
}

/**
 * The counts beside the sync glyph, as VSCode arranges them: behind then ahead.
 *
 * Empty when there is nothing either way — the glyph still shows, because "in
 * sync" is a thing worth being able to see, and two zeroes are not how to say it.
 */
export function syncCounts(tracking: Tracking | null): string {
  if (!tracking?.upstream) return "";
  const parts: string[] = [];
  if (tracking.behind > 0) parts.push(`\u2193${tracking.behind}`);
  if (tracking.ahead > 0) parts.push(`\u2191${tracking.ahead}`);
  return parts.join("");
}

/**
 * What clicking the sync item does.
 *
 * Not VSCode's sync, which pulls *and pushes*. Pushing from a status bar is a
 * decision this one does not make — Source Control has the button, and it knows
 * whether the branch needs an upstream setting first. So the click is the
 * useful, safe half in each state: take what is waiting, explain why it cannot
 * be taken, or go and ask the remote what it has.
 */
export type SyncAction = "pull" | "explain" | "fetch";

export function syncAction(tracking: Tracking | null): SyncAction {
  const news = upstreamNews(tracking);
  if (!news) return "fetch";
  return news.diverged ? "explain" : "pull";
}

/** The sync item's tooltip: exactly what a click will do, in its own words. */
export function syncTitle(tracking: Tracking | null): string {
  const news = upstreamNews(tracking);
  if (!news) {
    const ahead = tracking?.ahead ?? 0;
    const state =
      ahead > 0
        ? `${ahead} to push — pushing is in Source Control`
        : "Up to date with " + (tracking?.upstream ?? "the upstream");
    return `${state}\nClick to fetch`;
  }
  if (news.diverged) return `${describeNews(news)}, and you are ahead — click for why`;
  return `Click to pull ${describeNews(news)}`;
}

/** The chip's tooltip: everything the two arrows are compressing. */
export function trackingTitle(tracking: Tracking | null): string {
  const label = branchLabel(tracking);
  if (!label) return "Not a git repository";
  if (label.detached) return "Detached HEAD — no branch, no upstream";
  const lines = [label.unborn ? `${label.text} (no commits yet)` : label.text];
  if (!tracking?.upstream) {
    lines.push("No upstream: nothing to compare against");
    return lines.join("\n");
  }
  lines.push(`Tracking ${tracking.upstream}`);
  if (tracking.ahead > 0) lines.push(`${tracking.ahead} to push`);
  if (tracking.behind > 0) lines.push(`${tracking.behind} to pull`);
  if (tracking.ahead === 0 && tracking.behind === 0) lines.push("Up to date");
  return lines.join("\n");
}
