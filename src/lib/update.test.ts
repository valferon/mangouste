import { describe, expect, it } from "vitest";
import type { Release } from "./types";
import {
  compareVersions,
  isNewer,
  justUpdated,
  parseVersion,
  releaseLabel,
  releaseNotes,
  shouldAnnounce,
} from "./update";

const release = (over: Partial<Release> = {}): Release => ({
  version: "0.2.0",
  tag: "v0.2.0",
  name: "v0.2.0",
  notes: "## Fixed\n\n- a thing",
  url: "https://github.com/valferon/mangouste/releases/tag/v0.2.0",
  publishedAt: "2026-08-28T10:00:00Z",
  prerelease: false,
  ...over,
});

describe("parseVersion", () => {
  it("takes a tag with or without its v", () => {
    expect(parseVersion("v0.1.13")?.core).toEqual([0, 1, 13]);
    expect(parseVersion("0.1.13")?.core).toEqual([0, 1, 13]);
  });

  it("splits the pre-release off and drops build metadata", () => {
    expect(parseVersion("0.2.0-rc.1")).toEqual({ core: [0, 2, 0], pre: ["rc", "1"] });
    expect(parseVersion("0.2.0+abc123")).toEqual({ core: [0, 2, 0], pre: [] });
  });

  it("refuses what is not a version rather than reading it as zero", () => {
    expect(parseVersion("unknown")).toBeNull();
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("0.1.x")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares segments as numbers, which is the whole reason this exists", () => {
    // The string compare this replaces calls 0.1.9 the newer of these two.
    expect(compareVersions("0.1.13", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.9", "0.1.13")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
  });

  it("treats a missing segment as zero", () => {
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.1", "0.2")).toBe(1);
  });

  it("ranks a pre-release below the release it leads to", () => {
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBe(1);
    expect(compareVersions("0.2.0-rc.1", "0.2.0-rc.2")).toBe(-1);
    expect(compareVersions("0.2.0-rc", "0.2.0-rc.1")).toBe(-1);
    expect(compareVersions("0.2.0-alpha", "0.2.0-beta")).toBe(-1);
    // Numeric identifiers sort below alphanumeric ones.
    expect(compareVersions("0.2.0-1", "0.2.0-alpha")).toBe(-1);
  });

  it("says nothing rather than guessing when a side is unparseable", () => {
    expect(compareVersions("unknown", "0.1.13")).toBeNull();
    expect(compareVersions("0.1.13", "")).toBeNull();
  });
});

describe("isNewer", () => {
  it("is strict, and false whenever the answer is unknown", () => {
    expect(isNewer("0.2.0", "0.1.13")).toBe(true);
    expect(isNewer("0.1.13", "0.1.13")).toBe(false);
    expect(isNewer("0.1.12", "0.1.13")).toBe(false);
    expect(isNewer("0.2.0", "unknown")).toBe(false);
  });
});

describe("shouldAnnounce", () => {
  it("raises a newer published release", () => {
    expect(shouldAnnounce(release(), "0.1.13", "")).toBe(true);
  });

  it("stays quiet on the version already waved away", () => {
    expect(shouldAnnounce(release(), "0.1.13", "0.2.0")).toBe(false);
  });

  it("still raises the release after the one waved away", () => {
    expect(shouldAnnounce(release({ version: "0.3.0" }), "0.1.13", "0.2.0")).toBe(true);
  });

  it("stays quiet on the version running, and on older ones", () => {
    expect(shouldAnnounce(release({ version: "0.1.13" }), "0.1.13", "")).toBe(false);
    expect(shouldAnnounce(release({ version: "0.1.12" }), "0.1.13", "")).toBe(false);
  });

  it("never raises a pre-release on its own", () => {
    expect(shouldAnnounce(release({ prerelease: true }), "0.1.13", "")).toBe(false);
  });

  it("has nothing to say when nothing is published", () => {
    expect(shouldAnnounce(null, "0.1.13", "")).toBe(false);
  });

  it("stays quiet when the running version cannot be read", () => {
    expect(shouldAnnounce(release(), "unknown", "")).toBe(false);
  });
});

describe("justUpdated", () => {
  it("fires on the first run of a newer build", () => {
    expect(justUpdated("0.2.0", "0.1.13")).toBe(true);
  });

  it("does not fire again on the run after that", () => {
    expect(justUpdated("0.2.0", "0.2.0")).toBe(false);
  });

  it("does not treat a fresh install as an update", () => {
    expect(justUpdated("0.2.0", "")).toBe(false);
  });

  it("does not fire on a deliberate downgrade", () => {
    expect(justUpdated("0.1.13", "0.2.0")).toBe(false);
  });
});

describe("releaseLabel", () => {
  it("does not print the tag twice when it is also the title", () => {
    expect(releaseLabel(release())).toBe("v0.2.0");
  });

  it("carries a real title alongside its tag", () => {
    expect(releaseLabel(release({ name: "Sessions rail" }))).toBe("Sessions rail (v0.2.0)");
  });
});

describe("releaseNotes", () => {
  it("says so rather than rendering an empty sheet", () => {
    expect(releaseNotes(release({ notes: "   " }))).toContain("without notes");
  });

  it("otherwise hands the body straight to the markdown renderer", () => {
    expect(releaseNotes(release())).toBe("## Fixed\n\n- a thing");
  });
});
