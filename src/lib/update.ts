/**
 * Whether the release on GitHub is newer than the one running, and whether that
 * is worth saying.
 *
 * Every decision here is a pure function over two strings and what the user has
 * already been told, which is the point: "is 0.1.9 older than 0.1.13" is exactly
 * the comparison a string compare gets wrong, and it is not a question anyone
 * should have to reproduce by cutting a release to find out.
 *
 * Two questions, not one. *Is there something newer* drives the notice; *did
 * this build change since the last run* drives the what's-new sheet, and that
 * one is answered entirely from local state — the app knows it restarted into a
 * different version without asking anybody.
 */

import type { Release } from "./types";

/** A version split into the parts that compare. */
interface Parsed {
  /** The dotted numbers, as many as were given. */
  core: number[];
  /**
   * Everything after the first `-`, split on `.`. Empty for a final release.
   *
   * Semver's rule, and the one that matters here: a version *with* a
   * pre-release identifier is older than the same one without, so `0.2.0-rc.1`
   * never advertises itself over `0.2.0`.
   */
  pre: string[];
}

/** `null` when the string is not a version — which is not the same as `0`. */
export function parseVersion(raw: string): Parsed | null {
  const text = raw.trim().replace(/^v/i, "");
  if (!text) return null;
  // Build metadata is explicitly not part of precedence, so it is dropped
  // before anything else looks at the string.
  const [beforeBuild] = text.split("+", 1);
  const dash = beforeBuild.indexOf("-");
  const core = dash === -1 ? beforeBuild : beforeBuild.slice(0, dash);
  const pre = dash === -1 ? "" : beforeBuild.slice(dash + 1);
  const parts = core.split(".");
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return { core: numbers, pre: pre ? pre.split(".") : [] };
}

/** Compare two pre-release identifiers: numeric ones sort below alphanumeric. */
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // A final release outranks any pre-release of the same core.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    // The one that ran out of identifiers first is the smaller: `rc` < `rc.1`.
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const left = /^\d+$/.test(a[i]) ? Number(a[i]) : null;
    const right = /^\d+$/.test(b[i]) ? Number(b[i]) : null;
    if (left !== null && right !== null) {
      if (left !== right) return left < right ? -1 : 1;
      continue;
    }
    if (left !== null) return -1;
    if (right !== null) return 1;
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * `-1`, `0`, `1`, or `null` when either side is not a version.
 *
 * `null` and not a guess: an unparseable version is what an unbundled dev build
 * or a failed `getVersion()` looks like, and the honest answer there is "cannot
 * say", which every caller turns into silence.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i += 1) {
    // A missing segment is zero: `0.2` and `0.2.0` are the same version.
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

/** Strictly newer. Equal, older and unknown are all `false`. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

/**
 * Whether to raise this release, given what has already been waved away.
 *
 * Dismissal is per version rather than a blanket mute: saying "not now" to
 * 0.2.0 must not also swallow 0.3.0, because the whole value of the notice is
 * that it arrives for the release you have not seen. A pre-release is never
 * raised on its own — `/releases/latest` does not return one, so a prerelease
 * here only ever arrives from a tag lookup, where the sheet was asked for.
 */
export function shouldAnnounce(
  release: Release | null,
  currentVersion: string,
  dismissedVersion: string,
): boolean {
  if (!release || release.prerelease) return false;
  if (release.version === dismissedVersion) return false;
  return isNewer(release.version, currentVersion);
}

/**
 * Whether this run is the first one on a version, and so owes a what's-new.
 *
 * `lastRun` empty is a fresh install or a store that predates this key. Neither
 * is an update, and greeting a first launch with "here is what changed" is a
 * sheet about a release the user has never seen the previous one of.
 *
 * Strictly forward: a downgrade — running an older bundle against a store
 * written by a newer one — is a deliberate act, and answering it with release
 * notes for the version they just left would be nonsense.
 */
export function justUpdated(currentVersion: string, lastRun: string): boolean {
  if (!lastRun) return false;
  return isNewer(currentVersion, lastRun);
}

/** How the About sheet and the status chip label a release. */
export function releaseLabel(release: Release): string {
  return release.name === release.tag ? release.tag : `${release.name} (${release.tag})`;
}

/** Notes worth rendering, or a line saying there are none rather than a blank sheet. */
export function releaseNotes(release: Release): string {
  return release.notes.trim() || "_This release was published without notes._";
}
