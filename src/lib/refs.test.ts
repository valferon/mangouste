import { describe, expect, it } from "vitest";

import { collapseRefs, describeRefs, type CommitRef } from "./refs";

const kinds = (refs: CommitRef[]) => refs.map((ref) => `${ref.kind}:${ref.label}`);

describe("describeRefs", () => {
  it("reads the checked-out branch out of the HEAD arrow", () => {
    expect(kinds(describeRefs(["HEAD -> main"]))).toEqual(["head:main"]);
  });

  it("keeps a detached HEAD as itself", () => {
    expect(kinds(describeRefs(["HEAD"]))).toEqual(["head:HEAD"]);
  });

  it("strips the tag marker", () => {
    expect(kinds(describeRefs(["tag: v1.2.0"]))).toEqual(["tag:v1.2.0"]);
  });

  it("tells a remote from a local branch by the branch list, not by the slash", () => {
    const remotes = ["origin/main", "origin/feat/thing"];
    expect(kinds(describeRefs(["feat/thing", "origin/feat/thing"], remotes))).toEqual([
      "local:feat/thing",
      "remote:origin/feat/thing",
    ]);
  });

  it("falls back to the slash when the branch list has not loaded", () => {
    expect(kinds(describeRefs(["origin/main", "main"]))).toEqual(["local:main", "remote:origin/main"]);
  });

  it("drops the remote's symbolic HEAD, which only repeats its default branch", () => {
    expect(kinds(describeRefs(["origin/master", "origin/HEAD"], ["origin/master", "origin/HEAD"]))).toEqual([
      "remote:origin/master",
    ]);
  });

  it("orders head, local, tag, remote, and keeps git's order inside each", () => {
    const refs = ["origin/main", "tag: v2", "release", "HEAD -> main", "origin/release", "main"];
    const remotes = ["origin/main", "origin/release"];
    expect(kinds(describeRefs(refs, remotes))).toEqual([
      "head:main",
      "local:release",
      "local:main",
      "tag:v2",
      "remote:origin/main",
      "remote:origin/release",
    ]);
  });

  it("ignores the empty string a commit with no refs parses to", () => {
    expect(describeRefs(["", "  "])).toEqual([]);
  });
});

describe("collapseRefs", () => {
  const refs = describeRefs(["HEAD -> main", "release", "tag: v2", "origin/main"], ["origin/main"]);

  it("shows everything that fits", () => {
    expect(collapseRefs(refs.slice(0, 2), 2)).toEqual({ shown: refs.slice(0, 2), hidden: [] });
  });

  it("shows one over the limit rather than collapsing it into a +1 of the same width", () => {
    const chips = collapseRefs(refs.slice(0, 3), 2);
    expect(chips.shown).toHaveLength(3);
    expect(chips.hidden).toEqual([]);
  });

  it("collapses the rest once there are two of them", () => {
    const chips = collapseRefs(refs, 2);
    expect(kinds(chips.shown)).toEqual(["head:main", "local:release"]);
    expect(kinds(chips.hidden)).toEqual(["tag:v2", "remote:origin/main"]);
  });

  it("collapses the lot when the row has no room at all", () => {
    expect(collapseRefs(refs, 0).shown).toEqual([]);
    expect(collapseRefs(refs, 0).hidden).toEqual(refs);
  });
});
