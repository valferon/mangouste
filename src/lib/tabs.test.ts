import { describe, expect, it } from "vitest";
import {
  cleanStoredTabs,
  isStoredTab,
  restoreTab,
  storedTabId,
  tabInRepo,
  tabRepo,
  toStoredTab,
  type StoredTab,
  type Tab,
} from "./tabs";

const chatTab: Tab = {
  kind: "chat",
  id: "chat|/repos/mangouste|abc-123",
  cwd: "/repos/mangouste",
  sessionId: "abc-123",
  resumeFile: "/home/v/.claude/projects/x/abc-123.jsonl",
  surface: "chat",
};

const fileTab: Tab = {
  kind: "file",
  id: "file:/repos/mangouste/src/App.tsx",
  label: "App.tsx",
  path: "/repos/mangouste/src/App.tsx",
  cwd: "/repos/mangouste",
};

const historyTab: Tab = {
  kind: "history",
  id: "history|/repos/mangouste",
  label: "History",
  cwd: "/repos/mangouste",
};

const dashboardTab: Tab = { kind: "dashboard", id: "dashboard", label: "Dashboard" };

describe("toStoredTab", () => {
  it("drops a diff tab, whose patch is derived output", () => {
    // Storing the patch would put a whole diff in localStorage, and it would
    // be stale against the worktree by the next run anyway.
    const diff: Tab = {
      kind: "diff",
      id: "diff|/repos/mangouste|staged",
      label: "staged",
      patch: "--- a\n+++ b",
      cwd: "/repos/mangouste",
    };
    expect(toStoredTab(diff)).toBeNull();
  });

  it("drops a chat tab whose sessionId is still null", () => {
    // A "New session" tab has no session to resume and no transcript to
    // render; restoring one would be a blank pane pretending to be history.
    const fresh: Tab = {
      kind: "chat",
      id: "chat|/repos/mangouste|new-1",
      cwd: "/repos/mangouste",
      sessionId: null,
      resumeFile: null,
      surface: "chat",
    };
    expect(toStoredTab(fresh)).toBeNull();
  });

  it("drops a terminal tab claude has not written a transcript for", () => {
    // A terminal tab has its id from the moment it is minted, so unlike a pane
    // the id is not evidence of a session. Restoring one without a transcript
    // would relaunch as `--resume` against something that does not exist.
    const untouched: Tab = {
      ...chatTab,
      id: "chat|/repos/mangouste|new-2",
      resumeFile: null,
      surface: "terminal",
    };
    expect(toStoredTab(untouched)).toBeNull();
  });

  it("keeps a terminal tab that has one, and remembers the surface", () => {
    expect(toStoredTab({ ...chatTab, surface: "terminal" })).toEqual({
      kind: "chat",
      cwd: chatTab.cwd,
      sessionId: "abc-123",
      resumeFile: chatTab.resumeFile,
      surface: "terminal",
    });
  });

  it("keeps a chat tab with a null resumeFile, which is a real state", () => {
    // null means "no transcript yet", not "malformed" — the back-fill effect
    // in App repairs it later, so it must survive the round trip as null.
    const stored = toStoredTab({ ...chatTab, resumeFile: null });
    expect(stored).toEqual({
      kind: "chat",
      cwd: chatTab.cwd,
      sessionId: "abc-123",
      resumeFile: null,
      surface: "chat",
    });
  });
});

describe("toStoredTab -> restoreTab", () => {
  // The property pinned here: a restored tab is indistinguishable from the
  // live tab it came from — same id, same label — so the strip after a
  // relaunch is the strip before it.
  it("round trips a chat tab", () => {
    const stored = toStoredTab(chatTab);
    expect(stored).not.toBeNull();
    expect(restoreTab(stored as StoredTab)).toEqual(chatTab);
  });

  it("round trips a file tab, label included", () => {
    const stored = toStoredTab(fileTab);
    expect(stored).not.toBeNull();
    expect(restoreTab(stored as StoredTab)).toEqual(fileTab);
  });

  it("round trips a history tab", () => {
    // Unlike a diff, a history tab stores nothing derived: it is a repo, and
    // the log behind it is re-read on open.
    const stored = toStoredTab(historyTab);
    expect(stored).not.toBeNull();
    expect(restoreTab(stored as StoredTab)).toEqual(historyTab);
  });

  it("round trips the dashboard", () => {
    const stored = toStoredTab(dashboardTab);
    expect(stored).not.toBeNull();
    expect(restoreTab(stored as StoredTab)).toEqual(dashboardTab);
  });
});

describe("storedTabId", () => {
  // Literal strings, asserted against what App mints in openSessionTab,
  // openFile and DASHBOARD_TAB. A drifted format does not fail loudly: the
  // restored tab just duplicates the moment the same thing is opened again.
  it("mints the chat id App would", () => {
    const stored = toStoredTab(chatTab) as StoredTab;
    expect(storedTabId(stored)).toBe("chat|/repos/mangouste|abc-123");
  });

  it("mints the file id App would", () => {
    const stored = toStoredTab(fileTab) as StoredTab;
    expect(storedTabId(stored)).toBe("file:/repos/mangouste/src/App.tsx");
  });

  it("mints the history id App would", () => {
    const stored = toStoredTab(historyTab) as StoredTab;
    expect(storedTabId(stored)).toBe("history|/repos/mangouste");
  });

  it("mints the dashboard's fixed id", () => {
    expect(storedTabId({ kind: "dashboard" })).toBe("dashboard");
  });
});

describe("isStoredTab", () => {
  const goodChat = {
    kind: "chat",
    cwd: "/repos/mangouste",
    sessionId: "abc-123",
    resumeFile: null,
  };

  it("accepts each member of the union", () => {
    expect(isStoredTab(goodChat)).toBe(true);
    expect(isStoredTab({ ...goodChat, resumeFile: "/tmp/t.jsonl" })).toBe(true);
    expect(isStoredTab({ kind: "file", cwd: "/a", path: "/a/b.ts" })).toBe(true);
    expect(isStoredTab({ kind: "dashboard" })).toBe(true);
  });

  it("takes an entry with no surface, which is the shape before terminals", () => {
    // Absent means the only surface there used to be. Dropping those entries
    // would empty the strip of everyone who upgrades.
    expect(isStoredTab(goodChat)).toBe(true);
    expect(restoreTab(goodChat as StoredTab)).toMatchObject({ surface: "chat" });
  });

  it("accepts either surface, and rejects a value that is neither", () => {
    expect(isStoredTab({ ...goodChat, surface: "chat" })).toBe(true);
    expect(isStoredTab({ ...goodChat, surface: "terminal" })).toBe(true);
    // A tab with no renderer is worse than a missing tab.
    expect(isStoredTab({ ...goodChat, surface: "pane" })).toBe(false);
    expect(isStoredTab({ ...goodChat, surface: null })).toBe(false);
  });

  it("rejects a kind this build does not know", () => {
    // "diff" is a live kind but never a stored one; anything else is noise.
    expect(isStoredTab({ kind: "diff", path: "/a" })).toBe(false);
    expect(isStoredTab({ kind: "split", path: "/a" })).toBe(false);
  });

  it("rejects a chat entry missing cwd", () => {
    expect(isStoredTab({ kind: "chat", sessionId: "abc", resumeFile: null })).toBe(false);
  });

  it("rejects a file entry missing cwd, which older builds wrote", () => {
    // Without a repo the strip has nowhere to show it, so it is dropped rather
    // than restored into every repo at once — which is the bug this fixes.
    expect(isStoredTab({ kind: "file", path: "/a/b.ts" })).toBe(false);
  });

  it("rejects a sessionId of the wrong type", () => {
    // null is a legal ChatTab state but never a legal stored one — toStoredTab
    // filters it at write time, so at read time it can only mean corruption.
    expect(isStoredTab({ ...goodChat, sessionId: null })).toBe(false);
    expect(isStoredTab({ ...goodChat, sessionId: 7 })).toBe(false);
  });

  it("rejects resumeFile undefined, which is not the same as null", () => {
    // An absent field would restore as `undefined`; ChatPane's cold start
    // distinguishes "no transcript" (null) from a path to read.
    expect(isStoredTab({ kind: "chat", cwd: "/a", sessionId: "s" })).toBe(false);
    expect(isStoredTab({ ...goodChat, resumeFile: undefined })).toBe(false);
  });

  it("rejects non-objects and null", () => {
    expect(isStoredTab("chat")).toBe(false);
    expect(isStoredTab(7)).toBe(false);
    expect(isStoredTab(null)).toBe(false);
    expect(isStoredTab(["chat"])).toBe(false);
  });
});

describe("isStoredTab, history", () => {
  it("takes a history entry with a repo", () => {
    expect(isStoredTab({ kind: "history", cwd: "/repos/mangouste" })).toBe(true);
  });

  it("drops one without", () => {
    expect(isStoredTab({ kind: "history" })).toBe(false);
  });
});

describe("cleanStoredTabs", () => {
  it("drops one bad entry without losing the others", () => {
    // The property that matters: corruption costs one tab, not the whole strip.
    const out = cleanStoredTabs([
      { kind: "file", cwd: "/a", path: "/a/b.ts" },
      { kind: "chat", cwd: "/a" },
      { kind: "dashboard" },
    ]);
    expect(out).toEqual([
      { kind: "file", cwd: "/a", path: "/a/b.ts" },
      { kind: "dashboard" },
    ]);
  });

  it("returns [] for a non-array", () => {
    expect(cleanStoredTabs(null)).toEqual([]);
    expect(cleanStoredTabs({ 0: { kind: "dashboard" } })).toEqual([]);
    expect(cleanStoredTabs("[]")).toEqual([]);
  });
});

describe("tabRepo / tabInRepo", () => {
  // The rule the whole strip rests on: every tab but the dashboard is owned by
  // one repo, and App filters with `tabInRepo` in five places that must agree.
  it("reports the owning repo of each kind", () => {
    expect(tabRepo(chatTab)).toBe("/repos/mangouste");
    expect(tabRepo(fileTab)).toBe("/repos/mangouste");
    expect(tabRepo(dashboardTab)).toBeNull();
  });

  it("hides another repo's chat, file and diff tabs", () => {
    const diff: Tab = {
      kind: "diff",
      id: "diff|/repos/mangouste|src/App.tsx",
      label: "src/App.tsx",
      patch: "",
      cwd: "/repos/mangouste",
    };
    for (const tab of [chatTab, fileTab, diff]) {
      expect(tabInRepo(tab, "/repos/mangouste")).toBe(true);
      expect(tabInRepo(tab, "/repos/other")).toBe(false);
    }
  });

  it("shows the dashboard in every repo, including none", () => {
    // It is the cross-repo watch surface, and clicking a row on it switches
    // repo — a dashboard owned by a repo would hide itself the moment it was
    // used.
    expect(tabInRepo(dashboardTab, "/repos/mangouste")).toBe(true);
    expect(tabInRepo(dashboardTab, "/repos/other")).toBe(true);
    expect(tabInRepo(dashboardTab, "")).toBe(true);
  });

  it("shows a tab whose repo is the no-repo window's empty root", () => {
    // A window with no repo discovered runs with activeRepo "", and the tabs
    // it mints carry "" too; they must not be filtered out of their own strip.
    const homeless: Tab = { ...fileTab, cwd: "" };
    expect(tabInRepo(homeless, "")).toBe(true);
    expect(tabInRepo(homeless, "/repos/mangouste")).toBe(false);
  });
});
