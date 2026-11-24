import { beforeEach, describe, expect, it } from "vitest";
import { forgetServed, markServed, servedUpTo, unserved } from "./servedRequests";

beforeEach(() => forgetServed());

describe("servedRequests", () => {
  it("starts with nothing served", () => {
    expect(servedUpTo("chat|/repo|s1", "paste")).toBe(0);
    expect(servedUpTo("chat|/repo|s1", "direct")).toBe(0);
  });

  it("remembers the newest token per pane and per channel", () => {
    markServed("chat|/repo|s1", "paste", 4);
    expect(servedUpTo("chat|/repo|s1", "paste")).toBe(4);
    // A paste served says nothing about a follow-up, or about another pane.
    expect(servedUpTo("chat|/repo|s1", "direct")).toBe(0);
    expect(servedUpTo("chat|/repo|s2", "paste")).toBe(0);
  });

  it("never moves backwards", () => {
    markServed("chat|/repo|s1", "direct", 9);
    markServed("chat|/repo|s1", "direct", 3);
    expect(servedUpTo("chat|/repo|s1", "direct")).toBe(9);
  });

  it("hands a pane only the requests it has not acted on", () => {
    const requests = [
      { token: 2, text: "first" },
      { token: 5, text: "second" },
    ];
    expect(unserved("chat|/repo|s1", "direct", requests)).toEqual(requests);
    markServed("chat|/repo|s1", "direct", 2);
    expect(unserved("chat|/repo|s1", "direct", requests)).toEqual([requests[1]]);
  });

  /**
   * The bug this module exists for. The pane kept this memory in a ref, so it
   * died when the tab closed while the request stayed in App state under the
   * same id: the session reopened, the fresh pane found the request, and the
   * saved prompt was sent a second time.
   */
  it("a pane mounted again under the same id does not act on old requests", () => {
    const kept = [
      { token: 1, text: "nightly follow-up, first fire" },
      { token: 2, text: "nightly follow-up, second fire" },
    ];
    // First mount serves both, then its tab is closed.
    markServed("chat|/repo|s1", "direct", 2);
    // The schedule fires again: the tab is rebuilt with the kept list plus one.
    const next = [...kept, { token: 3, text: "nightly follow-up, third fire" }];
    expect(unserved("chat|/repo|s1", "direct", next).map((r) => r.token)).toEqual([3]);
  });
});
