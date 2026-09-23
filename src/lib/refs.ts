/**
 * The ref names `git log` hangs off a commit, made fit for a 300px row.
 *
 * `%D` hands the frontend one string per commit — `HEAD -> main, origin/main,
 * origin/HEAD, tag: v1.2` — and rendering it verbatim is what pushes the
 * subject off the end of the row: the refs of a merge commit are routinely
 * wider than the pane. This file decides what each ref *is*, what order they
 * read in, and which of them the row has the width to show.
 *
 * Pure, so the awkward ones (a detached HEAD, a local branch with a slash in
 * its name, a remote pointer that only ever repeats the default branch) are a
 * list of strings in a test rather than a repo to clone.
 */

/** What a ref points at, which is what its chip is coloured by. */
export type RefKind = "head" | "local" | "remote" | "tag";

export interface CommitRef {
  kind: RefKind;
  /** What the chip reads: the ref without its `HEAD ->` or `tag:` marker. */
  label: string;
  /** The ref as git wrote it, for the tooltip. */
  full: string;
}

export interface RefChips {
  shown: CommitRef[];
  /** The rest, in the order they would have been shown, for the `+N` tooltip. */
  hidden: CommitRef[];
}

/** Checked-out branch first, then local, tags, and the remotes last. */
const ORDER: Record<RefKind, number> = { head: 0, local: 1, tag: 2, remote: 3 };

/**
 * Classify and order one commit's refs.
 *
 * `remotes` is the branch list's remote-tracking names (`origin/main`), and is
 * what tells `feat/thing` from `origin/thing` — a slash is not the difference,
 * plenty of local branches have one. Without it the slash is all there is to
 * go on, which is the right guess for a repo whose branches have not loaded
 * yet and the wrong one for exactly the branches a slash heuristic misreads.
 *
 * `origin/HEAD` is dropped: it is a symbolic pointer at the remote's default
 * branch, so it is always a second chip saying what the chip beside it said.
 */
export function describeRefs(refs: readonly string[], remotes?: readonly string[]): CommitRef[] {
  const described = refs
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "")
    .map((ref): CommitRef => {
      if (ref.startsWith("HEAD -> ")) {
        return { kind: "head", label: ref.slice("HEAD -> ".length), full: ref };
      }
      if (ref === "HEAD") return { kind: "head", label: "HEAD", full: ref };
      if (ref.startsWith("tag: ")) {
        return { kind: "tag", label: ref.slice("tag: ".length), full: ref };
      }
      const remote = remotes ? remotes.includes(ref) : ref.includes("/");
      return { kind: remote ? "remote" : "local", label: ref, full: ref };
    })
    .filter((ref) => !(ref.kind === "remote" && ref.label.endsWith("/HEAD")));

  return described
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) => ORDER[a.ref.kind] - ORDER[b.ref.kind] || a.index - b.index)
    .map((entry) => entry.ref);
}

/**
 * Split the chips a row draws from the ones it counts.
 *
 * A row shows the refs that identify it and then stops: the eleventh
 * remote-tracking branch pointing at a release commit is not worth the subject
 * it would cost, and the `+N` chip it collapses into still names every one of
 * them on hover.
 */
export function collapseRefs(refs: readonly CommitRef[], limit: number): RefChips {
  const room = Math.max(0, limit);
  // Collapsing one ref into `+1` trades a name for a number of the same width.
  if (refs.length <= room + 1) return { shown: [...refs], hidden: [] };
  return { shown: refs.slice(0, room), hidden: refs.slice(room) };
}
