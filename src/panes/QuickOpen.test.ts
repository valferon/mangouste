import { describe, expect, it } from "vitest";
import { wantsNewWindow } from "./QuickOpen";

describe("wantsNewWindow", () => {
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false };

  it("keeps a plain pick in this window", () => {
    expect(wantsNewWindow(plain)).toBe(false);
  });

  it("opens a new window on Ctrl, Cmd or Shift", () => {
    expect(wantsNewWindow({ ...plain, ctrlKey: true })).toBe(true);
    expect(wantsNewWindow({ ...plain, metaKey: true })).toBe(true);
    expect(wantsNewWindow({ ...plain, shiftKey: true })).toBe(true);
  });
});
