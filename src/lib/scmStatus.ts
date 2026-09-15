/**
 * Porcelain status codes, read as a person would read them.
 *
 * `git status --porcelain` speaks in two-character XY pairs, and the pane used
 * to print them raw — which is how `??` ended up on screen next to real words.
 * A pair is one fact about a file, so it collapses to one letter and one tone,
 * and the pair itself moves to the tooltip for anyone who wants it back.
 */
export type ScmTone = "added" | "modified" | "deleted" | "renamed" | "conflict" | "ignored";

export interface ScmStatus {
  /** Single letter for the row's trailing column. */
  letter: string;
  tone: ScmTone;
  /** Long form, for the row's tooltip. */
  title: string;
}

const MEANINGS: Record<string, ScmStatus> = {
  A: { letter: "A", tone: "added", title: "Added" },
  M: { letter: "M", tone: "modified", title: "Modified" },
  D: { letter: "D", tone: "deleted", title: "Deleted" },
  R: { letter: "R", tone: "renamed", title: "Renamed" },
  C: { letter: "C", tone: "renamed", title: "Copied" },
  T: { letter: "T", tone: "modified", title: "Type changed" },
  U: { letter: "!", tone: "conflict", title: "Conflicted" },
};

/**
 * Both halves of the pair are consulted, worktree side first: a file staged as
 * added and then edited is still, to the person looking at the row, a new file
 * they are working on — but `UU` outranks everything, because a conflict is the
 * one status that has to be dealt with before any of the others matter.
 */
export function scmStatus(code: string): ScmStatus {
  const pair = code.padEnd(2, " ").slice(0, 2);
  if (pair === "??") return { letter: "U", tone: "added", title: "Untracked" };
  if (pair === "!!") return { letter: "I", tone: "ignored", title: "Ignored" };

  const [index, worktree] = [pair[0], pair[1]];
  if (index === "U" || worktree === "U" || (index === "A" && worktree === "A")) {
    return MEANINGS.U;
  }
  return MEANINGS[index] ?? MEANINGS[worktree] ?? { letter: "·", tone: "modified", title: code };
}
