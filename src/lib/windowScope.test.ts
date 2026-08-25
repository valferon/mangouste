import { describe, expect, it } from "vitest";
import { keySuffix, scopeKey } from "./windowScope";

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
