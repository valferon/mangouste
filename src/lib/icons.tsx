import type { SVGProps } from "react";
import type { SessionStatus } from "./types";

/**
 * Inline SVG glyphs, sized in `em` so they track the text they sit beside and
 * painted in `currentColor` so they inherit whatever the surrounding pane sets.
 *
 * Hand-drawn rather than pulled from an icon font: the app ships no webfonts,
 * and a dependency-free module keeps the bundle a single JS file.
 */
type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : "icon"}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Source-control glyph: a side branch curving back into the trunk. */
export function SourceControlIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="3" r="1.9" />
      <circle cx="5" cy="13" r="1.9" />
      <circle cx="11.5" cy="3" r="1.9" />
      <path d="M5 4.9v6.2" />
      <path d="M11.5 4.9v1.3a3 3 0 0 1-3 3H6.9" />
    </Icon>
  );
}

/** Branch glyph for the current-HEAD chip. */
export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="3.5" r="1.9" />
      <circle cx="4.5" cy="12.5" r="1.9" />
      <circle cx="11.5" cy="8" r="1.9" />
      <path d="M4.5 5.4v5.2" />
      <path d="M9.6 8H7.5a3 3 0 0 1-3-3" />
    </Icon>
  );
}

/** Stage: a plus, matching the VSCode SCM row action. */
export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9" />
      <path d="M3.5 8h9" />
    </Icon>
  );
}

/** Unstage: a minus. */
export function MinusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8h9" />
    </Icon>
  );
}

/** Discard: an anticlockwise arrow back to the last committed state. */
export function DiscardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <path d="M3 3v3h3" />
    </Icon>
  );
}

/** Commit: a tick, for the commit button. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </Icon>
  );
}

/** Pull: an arrow down into a line. */
export function PullIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5v8" />
      <path d="M4.8 7.3 8 10.5l3.2-3.2" />
      <path d="M3 13.5h10" />
    </Icon>
  );
}

/** Push: an arrow up out of a line. */
export function PushIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 13.5v-8" />
      <path d="M4.8 8.7 8 5.5l3.2 3.2" />
      <path d="M3 2.5h10" />
    </Icon>
  );
}

/** Fetch: two arrows chasing each other round a circle. Distinct from
    `RefreshIcon`, which re-reads local state rather than talking to a remote. */
export function FetchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.2 7.2A5.3 5.3 0 0 0 3.8 4.6" />
      <path d="M2.8 8.8a5.3 5.3 0 0 0 9.4 2.6" />
      <path d="M3.6 2v2.7h2.7" />
      <path d="M12.4 14v-2.7H9.7" />
    </Icon>
  );
}

/** Merge: a side branch joining the trunk from above. */
export function MergeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="3.5" r="1.9" />
      <circle cx="11.5" cy="3.5" r="1.9" />
      <circle cx="4.5" cy="12.5" r="1.9" />
      <path d="M4.5 5.4v5.2" />
      <path d="M11.5 5.4v1.1a3 3 0 0 1-3 3H6.4" />
    </Icon>
  );
}

/** A commit: one node on the history line. */
export function CommitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M1 8h4.4M10.6 8H15" />
    </Icon>
  );
}

/** Refresh, replacing the ⟳ character in pane actions. */
export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.3 8a5.3 5.3 0 1 1-1.6-3.8" />
      <path d="M13.4 2.2v2.6h-2.6" />
    </Icon>
  );
}

/** Pencil, for inline rename affordances. */
export function PencilIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.9 3.1l3 3L5.4 13.5l-3.7.7.7-3.7z" />
      <path d="M11.6 1.4l3 3" />
    </Icon>
  );
}

/** Repo group header marker: a window with a stand, as the plugin draws it. */
export function RepoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="1.8" y="2.6" width="12.4" height="8.4" rx="1.6" />
      <path d="M6.4 13.4h3.2" />
    </Icon>
  );
}

/** Chevron marking the repo the other panes are currently loaded with. */
export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Icon>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.8" width="12" height="3" rx="1" />
      <path d="M3.2 5.8v6.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.8" />
      <path d="M6.4 8.6h3.2" />
    </Icon>
  );
}

export function UnarchiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="2.8" width="12" height="3" rx="1" />
      <path d="M3.2 5.8v6.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.8" />
      <path d="M8 12V8m0 0L6.2 9.8M8 8l1.8 1.8" />
    </Icon>
  );
}

/** Magnifier for the sessions filter box. */
export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6.8" cy="6.8" r="4.3" />
      <path d="M10 10l3.4 3.4" />
    </Icon>
  );
}

/** Clears the filter box. */
export function ClearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

/** Escalation control: search the transcripts themselves, not just their names. */
export function DeepSearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3.2h7.2L13 6v6.8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M5.4 7.4h5.2M5.4 10h3.4" />
    </Icon>
  );
}

/** Toggle for the read flag: a filled dot reads as "unread" everywhere. */
export function UnreadToggleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.4" />
      <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function ReadToggleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.4" />
    </Icon>
  );
}

/** Header action: clear the whole unread backlog. Mail's double check. */
export function MarkAllReadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M1.6 8.6 4.6 11.6 9.8 5" />
      <path d="M8.2 10.4 9.4 11.6 14.6 5" />
    </Icon>
  );
}

/**
 * Session status, one glyph per state.
 *
 * Shape carries the meaning and colour only reinforces it, so the five states
 * stay apart for anyone who cannot separate the palette — and at the 13 px this
 * renders at, a silhouette is legible where a hue shift is not. The `.glyph-ring`
 * class is what the stylesheet animates for the two live states.
 */
export function StatusGlyph({ status, ...rest }: { status: SessionStatus } & IconProps) {
  const props = { ...rest, className: "status-glyph", "data-status": status };
  switch (status) {
    // A turn is in flight: solid core, spinner arc. The stylesheet rotates the
    // whole <svg> — WebKitGTK animates transforms on the HTML-level element
    // reliably where it will not on an SVG child.
    case "active":
      return (
        <Icon {...props}>
          <path d="M8 1.8a6.2 6.2 0 1 1-6.2 6.2" className="glyph-ring" />
          <circle cx="8" cy="8" r="3.2" fill="currentColor" stroke="none" />
        </Icon>
      );
    // Blocked on you. A target, because this is the one state you must act on.
    case "awaiting":
      return (
        <Icon {...props}>
          <circle cx="8" cy="8" r="6.4" className="glyph-ring" />
          <circle cx="8" cy="8" r="3.4" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
        </Icon>
      );
    // Ended cleanly, but you have not looked at it since. Same silhouette as
    // finished — the turn ended either way — with the ring that says it wants you.
    case "pendingReview":
      return (
        <Icon {...props}>
          <circle cx="8" cy="8" r="6.9" className="glyph-ring" />
          <circle cx="8" cy="8" r="4.6" fill="currentColor" stroke="none" />
          <path d="M5.9 8.2 7.4 9.7 10.2 6.5" stroke="var(--bg-elevated)" />
        </Icon>
      );
    // Ended cleanly and you have seen it.
    case "finished":
      return (
        <Icon {...props}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M5.2 8.3 7.2 10.3 10.9 6" />
        </Icon>
      );
    // Went quiet mid-turn: ESC, a dead window, or an API error. Resumable.
    case "interrupted":
      return (
        <Icon {...props}>
          <circle cx="8" cy="8" r="6.2" />
          <path d="M8 4.6v4" />
          <circle cx="8" cy="11.1" r="0.85" fill="currentColor" stroke="none" />
        </Icon>
      );
    // Nothing for over a day.
    default:
      return (
        <Icon {...props}>
          <circle cx="8" cy="8" r="6.2" strokeDasharray="2.6 2.4" />
        </Icon>
      );
  }
}

/**
 * A subagent fan-out. Deliberately not one of the five session shapes: a
 * subagent is a child of a row, not a sixth thing a session can be. The ring
 * animates while it works, matching the session glyphs above.
 */
export function SubagentGlyph({ running, ...rest }: { running: boolean } & IconProps) {
  const props = { ...rest, className: "subagent-glyph", "data-running": running };
  return (
    <Icon {...props}>
      {running && <circle cx="8" cy="8" r="5.6" className="glyph-ring" />}
      <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** A Workflow-tool run: the parent of a group of agent rows. */
export function WorkflowGlyph(props: IconProps) {
  const merged = { ...props, className: "workflow-glyph" };
  return (
    <Icon {...merged}>
      <rect x="2.2" y="2.2" width="5" height="5" rx="1.2" />
      <rect x="8.8" y="8.8" width="5" height="5" rx="1.2" />
      <path d="M4.7 7.6v2.1a1.6 1.6 0 0 0 1.6 1.6h2.2" />
    </Icon>
  );
}
