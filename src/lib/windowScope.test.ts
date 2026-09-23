import { describe, expect, it } from "vitest";
import { keySuffix, scopeKey, windowName, windowNumber, windowTint } from "./windowScope";

describe("keySuffix", () => {
  it("leaves the main window's keys exactly as they were", () => {
    // The upgrade path: an install that has only ever had one window keeps its
    // tab strip, its widths and its workspace root.
    expect(keySuffix("main")).toBe("");
    expect(scopeKey("mangouste.openTabs", "main")).toBe("mangouste.openTabs");
  });

  it("gives every other window its own shard", () => {
    expect(scopeKey("mangouste.openTabs", "window-2")).toBe("mangouste.openTabs.window-2");
    expect(scopeKey("mangouste.openTabs", "window-3")).toBe("mangouste.openTabs.window-3");
  });

  it("keeps the mangouste. prefix every stored key is expected to carry", () => {
    expect(scopeKey("mangouste.activeTab", "window-2").startsWith("mangouste.")).toBe(true);
  });
});

describe("windowNumber", () => {
  it("counts the configured window as the first one", () => {
    expect(windowNumber("main")).toBe(1);
  });

  it("reads the number out of a minted label", () => {
    expect(windowNumber("window-2")).toBe(2);
    expect(windowNumber("window-7")).toBe(7);
  });

  it("falls back to the first window for a label it cannot read", () => {
    // A colour is cosmetic; a throw here would take the whole webview with it.
    expect(windowNumber("window-")).toBe(1);
    expect(windowNumber("devtools")).toBe(1);
  });
});

describe("windowTint", () => {
  it("leaves the main window painted in the theme's own accent", () => {
    expect(windowTint("main")).toBe("var(--accent)");
  });

  it("gives each further window a colour of its own", () => {
    const second = windowTint("window-2");
    const third = windowTint("window-3");
    expect(second).not.toBe(third);
    expect(second).not.toBe(windowTint("main"));
    // Mixed with the accent, so the bar still belongs to the theme.
    expect(second).toContain("var(--accent)");
  });

  it("wraps rather than running out", () => {
    expect(windowTint("window-7")).toBe(windowTint("window-2"));
  });
});

describe("windowName", () => {
  it("counts from one, the way a person would", () => {
    expect(windowName("main")).toBe("window 1");
    expect(windowName("window-3")).toBe("window 3");
  });
});
