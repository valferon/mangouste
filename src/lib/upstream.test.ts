import { describe, expect, it } from "vitest";

import {
  branchLabel,
  canFastForward,
  describeNews,
  newsKey,
  trackingTitle,
  upstreamNews,
  type Tracking,
} from "./upstream";

const tracking = (over: Partial<Tracking> = {}): Tracking => ({
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  ...over,
});

describe("branchLabel", () => {
  it("shows the branch", () => {
    expect(branchLabel(tracking())).toEqual({
      text: "main",
      detached: false,
      unborn: false,
    });
  });

  it("does not print git's sentence for a detached HEAD as a branch name", () => {
    // `## HEAD (no branch)` in a chip full of branch names reads as a branch
    // called HEAD.
    const label = branchLabel(tracking({ branch: "HEAD (no branch)", upstream: null }));
    expect(label).toEqual({ text: "detached", detached: true, unborn: false });
  });

  it("keeps the name of a branch with no commits on it yet", () => {
    expect(branchLabel(tracking({ branch: "No commits yet on main", upstream: null }))).toEqual({
      text: "main",
      detached: false,
      unborn: true,
    });
  });

  it("is nothing at all outside a repo", () => {
    expect(branchLabel(null)).toBeNull();
    expect(branchLabel(tracking({ branch: null }))).toBeNull();
  });
});

describe("upstreamNews", () => {
  it("reports commits waiting upstream", () => {
    expect(upstreamNews(tracking({ behind: 3 }))).toEqual({
      behind: 3,
      upstream: "origin/main",
      diverged: false,
    });
  });

  it("says nothing when the branch is level with its upstream", () => {
    expect(upstreamNews(tracking())).toBeNull();
  });

  it("says nothing when the branch is only ahead", () => {
    // Being ahead is a push, and pushing is not this bar's decision.
    expect(upstreamNews(tracking({ ahead: 2 }))).toBeNull();
  });

  it("says nothing without an upstream to be behind", () => {
    expect(upstreamNews(tracking({ upstream: null, behind: 4 }))).toBeNull();
    expect(upstreamNews(null)).toBeNull();
  });

  it("marks a branch that has diverged", () => {
    expect(upstreamNews(tracking({ ahead: 1, behind: 2 }))?.diverged).toBe(true);
  });
});

describe("canFastForward", () => {
  it("is true only when there is something to take and nothing in the way", () => {
    expect(canFastForward(tracking({ behind: 1 }))).toBe(true);
    // Nothing to take.
    expect(canFastForward(tracking())).toBe(false);
    // Diverged: `--ff-only` would fail, so the button must not promise it.
    expect(canFastForward(tracking({ ahead: 1, behind: 1 }))).toBe(false);
    expect(canFastForward(null)).toBe(false);
  });
});

describe("describeNews", () => {
  it("counts in the singular when there is one", () => {
    expect(describeNews({ behind: 1, upstream: "origin/main", diverged: false })).toBe(
      "1 commit behind origin/main",
    );
    expect(describeNews({ behind: 7, upstream: "upstream/dev", diverged: false })).toBe(
      "7 commits behind upstream/dev",
    );
  });
});

describe("newsKey", () => {
  it("is the same news when nothing about it changed", () => {
    const news = { behind: 3, upstream: "origin/main", diverged: false };
    expect(newsKey("/repos/a", news)).toBe(newsKey("/repos/a", news));
  });

  it("is new news when more commits land", () => {
    // Dismissing three says nothing about the two that come after them.
    const three = { behind: 3, upstream: "origin/main", diverged: false };
    const five = { ...three, behind: 5 };
    expect(newsKey("/repos/a", three)).not.toBe(newsKey("/repos/a", five));
  });

  it("is per repo, and per upstream", () => {
    const news = { behind: 3, upstream: "origin/main", diverged: false };
    expect(newsKey("/repos/a", news)).not.toBe(newsKey("/repos/b", news));
    expect(newsKey("/repos/a", news)).not.toBe(
      newsKey("/repos/a", { ...news, upstream: "fork/main" }),
    );
  });
});

describe("trackingTitle", () => {
  it("spells out what the arrows compress", () => {
    expect(trackingTitle(tracking({ ahead: 2, behind: 3 }))).toBe(
      "main\nTracking origin/main\n2 to push\n3 to pull",
    );
  });

  it("says so when there is nothing to do", () => {
    expect(trackingTitle(tracking())).toBe("main\nTracking origin/main\nUp to date");
  });

  it("does not claim a comparison it cannot make", () => {
    expect(trackingTitle(tracking({ upstream: null }))).toBe(
      "main\nNo upstream: nothing to compare against",
    );
    expect(trackingTitle(tracking({ branch: "HEAD (no branch)", upstream: null }))).toBe(
      "Detached HEAD — no branch, no upstream",
    );
    expect(trackingTitle(null)).toBe("Not a git repository");
  });

  it("notes a branch that has no commits yet", () => {
    expect(trackingTitle(tracking({ branch: "No commits yet on main", upstream: null }))).toBe(
      "main (no commits yet)\nNo upstream: nothing to compare against",
    );
  });
});
