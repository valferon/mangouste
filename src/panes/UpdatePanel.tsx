import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

import { DownloadIcon } from "../lib/icons";
import { fetchRelease, openExternal } from "../lib/ipc";
import { KEYS, readString, writeString } from "../lib/persist";
import type { Release } from "../lib/types";
import { justUpdated, releaseLabel, releaseNotes, shouldAnnounce } from "../lib/update";
import { Markdown } from "./Markdown";

/**
 * How often the releases endpoint is asked whether there is a newer tag.
 *
 * Six hours, and once on launch. A desktop app is not a page that gets a fresh
 * build every hour — the news being checked for lands a handful of times a
 * month — so anything faster is spending someone's anonymous GitHub quota (60
 * requests an hour per IP, shared with everything else on that address) to be
 * told the same thing.
 */
const CHECK_MS = 6 * 60 * 60_000;

/**
 * How long after launch the first check waits.
 *
 * Startup is already reading transcripts, discovering repos and opening panes,
 * and a network call thrown into that competes with the frame that draws the
 * window. The news is hours old at best; it can wait twenty seconds.
 */
const FIRST_CHECK_MS = 20_000;

const DISMISSED_KEY = KEYS.release.updateDismissed;
const LAST_RUN_KEY = KEYS.release.lastRunVersion;

/** What the sheet is currently about. */
type Sheet =
  | { kind: "available"; release: Release }
  /** The notes for the build now running, after an update replaced the old one. */
  | { kind: "whatsNew"; release: Release }
  /** A check the user asked for that came back with nothing newer. */
  | { kind: "current"; version: string }
  | { kind: "checking" }
  | { kind: "error"; message: string };

/** What Help ▸ Check for Updates reaches. */
export interface UpdateActions {
  check: () => void;
}

interface UpdateStatusProps {
  /**
   * Whether to reach the network on a timer.
   *
   * Off still leaves the menu item working: an explicit "check for updates" is
   * a request, and refusing to answer it would make the preference mean
   * something it does not say. Off only stops the unprompted ones.
   */
  enabled: boolean;
  /** Published upward so the Help menu can force a check. */
  onRegister: (actions: UpdateActions | null) => void;
}

/**
 * "There is a newer mangouste", and what changed in it.
 *
 * A notice, not an updater. Three of the four things this app ships as cannot
 * be replaced in place by the process running out of them, so the honest end of
 * this flow is the release page in a browser — see `src-tauri/src/update.rs` for
 * why that is the whole feature.
 *
 * Lives in the status bar next to the branch chip because it is the same kind
 * of fact: something outside this window moved, and here is one click to deal
 * with it. Renders nothing at all when there is no news, which is almost always.
 */
export function UpdateStatus({ enabled, onRegister }: UpdateStatusProps) {
  /** The running bundle's version. Empty until the IPC answers. */
  const [current, setCurrent] = useState("");
  /** A newer release worth a chip. Null covers "none" and "already dismissed". */
  const [available, setAvailable] = useState<Release | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  /** Versions waved away, mirrored in localStorage so a restart honours them. */
  const dismissed = useRef(readString(DISMISSED_KEY));

  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .catch(() => "")
      .then((version) => {
        if (!cancelled) setCurrent(version);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The unprompted check. Silent about everything except good news.
   *
   * A failure here is a network that is down or a rate limit that is not the
   * user's fault, and neither is worth a status-bar notice about a feature
   * nobody asked to run. The manual path below does report them, because
   * somebody is waiting on that one.
   */
  const checkQuietly = useCallback(async (version: string) => {
    try {
      const release = await fetchRelease();
      setAvailable(shouldAnnounce(release, version, dismissed.current) ? release : null);
    } catch {
      // Try again on the next tick.
    }
  }, []);

  /** Help ▸ Check for Updates. Reports what it finds either way. */
  const checkNow = useCallback(async () => {
    const version = current || (await getVersion().catch(() => ""));
    setSheet({ kind: "checking" });
    try {
      const release = await fetchRelease();
      // An explicit check ignores the dismissal: asking is un-dismissing.
      if (release && shouldAnnounce(release, version, "")) {
        setAvailable(release);
        setSheet({ kind: "available", release });
      } else {
        setAvailable(null);
        setSheet({ kind: "current", version });
      }
    } catch (error) {
      setSheet({ kind: "error", message: String(error) });
    }
  }, [current]);

  useEffect(() => {
    onRegister({ check: () => void checkNow() });
    return () => onRegister(null);
  }, [onRegister, checkNow]);

  /**
   * What's new, once, on the first launch of a build that replaced another.
   *
   * The bundle carries no changelog, so the notes come from the release the
   * running tag names. The stamp is written whatever the lookup does — a
   * rate-limited launch must not queue the sheet up for every launch after it.
   */
  useEffect(() => {
    if (!current) return;
    const lastRun = readString(LAST_RUN_KEY);
    if (lastRun === current) return;
    writeString(LAST_RUN_KEY, current);
    if (!justUpdated(current, lastRun)) return;
    let cancelled = false;
    void fetchRelease(`v${current}`)
      .then((release) => {
        if (!cancelled && release) setSheet({ kind: "whatsNew", release });
      })
      .catch(() => {
        // No notes to show. The update still happened; nothing to report.
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  useEffect(() => {
    if (!enabled || !current) return;
    const first = window.setTimeout(() => void checkQuietly(current), FIRST_CHECK_MS);
    const timer = window.setInterval(() => void checkQuietly(current), CHECK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [enabled, current, checkQuietly]);

  const dismiss = useCallback((version: string) => {
    dismissed.current = version;
    writeString(DISMISSED_KEY, version);
    setAvailable(null);
    setSheet(null);
  }, []);

  return (
    <>
      {available && (
        <button
          className="status-update"
          title={`mangouste ${available.version} is available — you are on ${current}`}
          onClick={() => setSheet({ kind: "available", release: available })}
        >
          <DownloadIcon />
          <span>update {available.version}</span>
        </button>
      )}
      {sheet && (
        <UpdateSheet
          sheet={sheet}
          current={current}
          onDismiss={dismiss}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );
}

/**
 * The sheet, for all five things the check can come back with.
 *
 * One component rather than a dialog per outcome: they differ by a heading and
 * which buttons are live, and the notes body — the part worth reading — is the
 * same rendering in both of the cases that have one.
 */
function UpdateSheet({
  sheet,
  current,
  onDismiss,
  onClose,
}: {
  sheet: Sheet;
  current: string;
  onDismiss: (version: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const release = sheet.kind === "available" || sheet.kind === "whatsNew" ? sheet.release : null;
  const heading =
    sheet.kind === "whatsNew"
      ? "What's new"
      : sheet.kind === "available"
        ? "Update available"
        : "Check for updates";

  return (
    <div className="quickopen-scrim" onMouseDown={(event) => event.button === 0 && onClose()}>
      <div className="settings update" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pane-header">
          <span>{heading}</span>
          <div className="actions">
            <button className="toggle-button" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        {release && (
          <>
            <div className="about-head">
              <span className="about-name">{releaseLabel(release)}</span>
              {/* One fact each, because two dim strings side by side read as
                  one. Which version you are on is the question in front of an
                  update; when it has already been installed, the only thing
                  left to date is the release itself. */}
              {sheet.kind === "available" ? (
                <span className="about-version">you are on {current}</span>
              ) : (
                release.publishedAt && (
                  <span className="about-version">{release.publishedAt.slice(0, 10)}</span>
                )
              )}
            </div>
            <div className="update-notes selectable">
              <Markdown>{releaseNotes(release)}</Markdown>
            </div>
          </>
        )}

        {sheet.kind === "checking" && <div className="empty-note">Asking GitHub…</div>}
        {sheet.kind === "current" && (
          <div className="empty-note">
            {sheet.version
              ? `mangouste ${sheet.version} is the latest release.`
              : "Nothing newer has been published."}
          </div>
        )}
        {sheet.kind === "error" && <div className="empty-note">{sheet.message}</div>}

        <div className="setting-row about-actions">
          {release && (
            <button
              className="toggle-button"
              onClick={() => void openExternal(release.url)}
            >
              {sheet.kind === "available" ? "Download" : "Release page"}
            </button>
          )}
          {sheet.kind === "available" && (
            <button
              className="toggle-button"
              onClick={() => onDismiss(sheet.release.version)}
            >
              Skip this version
            </button>
          )}
          <button className="toggle-button" onClick={onClose}>
            Close
          </button>
        </div>
        {sheet.kind === "available" && (
          <p className="setting-hint update-hint">
            Downloads open in your browser. mangouste does not replace itself: a{" "}
            <code>.deb</code> install is apt's to update, and an app cannot swap the
            bundle it is running out of without a signing key this project does not
            ship. <code>Skip this version</code> silences {sheet.release.version} only — the
            release after it will still say so.
          </p>
        )}
      </div>
    </div>
  );
}
