import { describe, expect, it } from "vitest";
import { markTerms } from "./marks";

/** The rendered string, with matched runs wrapped, so a case is one line. */
const rendered = (text: string, terms: string[]) =>
  markTerms(text, terms)
    .map((segment) => (segment.hit ? `[${segment.text}]` : segment.text))
    .join("");

describe("markTerms", () => {
  it("marks every occurrence, keeping the text's own case", () => {
    expect(rendered("The SessionsPane row, and the pane again", ["pane"])).toBe(
      "The Sessions[Pane] row, and the [pane] again",
    );
  });

  it("returns the text untouched when there is nothing to mark", () => {
    expect(markTerms("nothing here", [])).toEqual([{ text: "nothing here", hit: false }]);
    expect(markTerms("nothing here", ["", "  "])).toEqual([
      { text: "nothing here", hit: false },
    ]);
    expect(rendered("nothing here", ["absent"])).toBe("nothing here");
  });

  it("prefers the longest term where two overlap", () => {
    // `rail` inside `railway` would otherwise leave a stray `way` unmarked and
    // split one hit into two.
    expect(rendered("the railway", ["rail", "railway"])).toBe("the [railway]");
  });

  it("merges runs that touch, so one hit draws one mark", () => {
    expect(markTerms("foobar", ["foo", "bar"])).toEqual([{ text: "foobar", hit: true }]);
  });

  it("counts multibyte text by character, not by byte", () => {
    // The reason the terms are re-found here rather than carried over from Rust:
    // its offsets are UTF-8 and this string is UTF-16.
    expect(rendered("café needle café", ["needle"])).toBe("café [needle] café");
    expect(rendered("héllo", ["héllo"])).toBe("[héllo]");
  });

  it("keeps a phrase whole", () => {
    expect(rendered("hit the rate limit again", ["rate limit"])).toBe(
      "hit the [rate limit] again",
    );
  });

  it("marks a whole-string match", () => {
    expect(markTerms("exact", ["exact"])).toEqual([{ text: "exact", hit: true }]);
    expect(markTerms("", ["exact"])).toEqual([{ text: "", hit: false }]);
  });
});
