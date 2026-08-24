import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectGroup, RepoInfo } from "../lib/types";

export interface QuickOpenEntry {
  path: string;
  label: string;
  /** Sessions currently active or awaiting. */
  live: number;
  total: number;
  /** Newest session activity, 0 when the repo has no sessions. */
  lastActivityMs: number;
}

interface QuickOpenProps {
  groups: ProjectGroup[];
  repos: RepoInfo[];
  onPick: (path: string) => void;
  onClose: () => void;
}

/**
 * Build the candidate list: repos that have sessions first, newest activity
 * first, then every other git repo alphabetically.
 *
 * Recency comes from the session store rather than the filesystem, so "recent"
 * means "recently worked on with Claude", which is the thing worth reopening.
 */
export function buildEntries(groups: ProjectGroup[], repos: RepoInfo[]): QuickOpenEntry[] {
  const entries: QuickOpenEntry[] = groups.map((group) => ({
    path: group.cwd,
    label: group.label,
    live: group.sessions.filter((s) => s.status === "active" || s.status === "awaiting").length,
    total: group.sessions.length,
    lastActivityMs: group.sessions[0]?.lastActivityMs ?? 0,
  }));

  const seen = new Set(entries.map((e) => e.path));
  const rest = repos
    .filter((repo) => !seen.has(repo.path))
    .map((repo) => ({ path: repo.path, label: repo.name, live: 0, total: 0, lastActivityMs: 0 }))
    .sort((a, b) => a.label.localeCompare(b.label));

  entries.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return [...entries, ...rest];
}

function relativeAge(ms: number): string {
  if (!ms) return "";
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * Type-to-filter repo switcher, in place of a 180-entry dropdown.
 *
 * Matching is a subsequence test over the repo name, then a substring test over
 * the full path — so "pay" finds `payments-service` and "ws/an" finds
 * `~/workspace/ansible`.
 */
export function QuickOpen({ groups, repos, onPick, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const all = useMemo(() => buildEntries(groups, repos), [groups, repos]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return all.slice(0, 60);
    return all
      .filter(
        (entry) =>
          isSubsequence(needle, entry.label.toLowerCase()) ||
          entry.path.toLowerCase().includes(needle),
      )
      .slice(0, 60);
  }, [all, query]);

  // Any change to the result set invalidates the highlighted row.
  useEffect(() => setCursor(0), [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = matches[cursor];
      if (picked) onPick(picked.path);
    }
  };

  return (
    <div
      className="quickopen-scrim"
      // Primary button only: a right-click here opens a menu instead of
      // dismissing the palette out from under it.
      onMouseDown={(event) => event.button === 0 && onClose()}
    >
      <div className="quickopen" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="Open recent — type to filter"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="quickopen-list" ref={listRef}>
          {matches.length === 0 && <div className="empty-note">No matching repo.</div>}
          {matches.map((entry, index) => (
            <div
              key={entry.path}
              className="quickopen-row"
              data-cursor={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => onPick(entry.path)}
              title={entry.path}
            >
              {entry.live > 0 && <span className="status-dot" data-status="active" />}
              <span className="qo-label">{entry.label}</span>
              <span className="qo-path">{entry.path}</span>
              {entry.total > 0 && (
                <span className="qo-meta">
                  {entry.total} · {relativeAge(entry.lastActivityMs)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** True when every character of `needle` appears in `haystack`, in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}
