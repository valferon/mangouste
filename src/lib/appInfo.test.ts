import { describe, expect, it } from "vitest";
import { platformLabel, webviewLabel } from "./appInfo";

/** Real strings: WebKitGTK on Linux, and the Chromium-flavoured one on Windows. */
const WEBKITGTK =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const EDGE_WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CHROME_ONLY = "SomeShell/1.0 Chrome/118.0.5993.88";

describe("webviewLabel", () => {
  it("names WebKit and its version on the platform this app targets", () => {
    expect(webviewLabel(WEBKITGTK)).toBe("WebKit 605.1.15");
  });

  it("prefers WebKit when a string claims both, as every Chromium UA does", () => {
    expect(webviewLabel(EDGE_WEBVIEW2)).toBe("WebKit 537.36");
  });

  it("falls back to Chromium when there is no AppleWebKit token", () => {
    expect(webviewLabel(CHROME_ONLY)).toBe("Chromium 118.0.5993.88");
  });

  it("says unknown rather than guessing", () => {
    expect(webviewLabel("")).toBe("unknown");
    expect(webviewLabel("curl/8.5.0")).toBe("unknown");
  });
});

describe("platformLabel", () => {
  it("takes the parenthetical, which is where the OS still lives", () => {
    expect(platformLabel(WEBKITGTK, "fallback")).toBe("X11; Linux x86_64");
    expect(platformLabel(EDGE_WEBVIEW2, "fallback")).toBe("Windows NT 10.0; Win64; x64");
  });

  it("uses the caller's fallback when there is no parenthetical", () => {
    expect(platformLabel("curl/8.5.0", "Linux x86_64")).toBe("Linux x86_64");
  });
});
