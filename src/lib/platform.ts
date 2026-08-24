/**
 * Which host this window is drawn on, and the one keyboard fact that follows.
 *
 * Detected from the user-agent rather than asked of Tauri: the answer is needed
 * while the `CHORD` table is being built, at module scope, and every IPC call is
 * a promise. WebKit reports the OS in the same parenthetical on both platforms,
 * so one regex covers WebKitGTK and WKWebView alike.
 *
 * Kept as a pure function plus one memoised reader so the mapping can be tested
 * without a browser standing behind it.
 */

/** Does this user-agent/platform pair describe a Mac? */
export function detectMac(userAgent: string, platform: string): boolean {
  return /^Mac/i.test(platform) || /Macintosh|Mac OS X/.test(userAgent);
}

let cached: boolean | undefined;

/**
 * True on macOS.
 *
 * A function, not a constant: `navigator` is absent in the test runner, and a
 * module-scope read would throw on import rather than in the one test that
 * cares.
 */
export function isMac(): boolean {
  if (cached !== undefined) return cached;
  const agent = typeof navigator === "undefined" ? undefined : navigator;
  cached = detectMac(agent?.userAgent ?? "", agent?.platform ?? "");
  return cached;
}

/** For tests: forget what was detected. */
export function resetPlatformCache(): void {
  cached = undefined;
}
